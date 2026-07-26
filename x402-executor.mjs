import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CALLER_JSON_PATH = process.env.CALLER_JSON_PATH || path.join(__dirname, "caller.json");
if (!fs.existsSync(CALLER_JSON_PATH)) {
  throw new Error(`지갑 파일이 존재하지 않습니다: ${CALLER_JSON_PATH}`);
}
const secretKeyArray = JSON.parse(fs.readFileSync(CALLER_JSON_PATH, "utf-8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));

function parseAuthHeader(headerStr) {
  const params = {};
  const regex = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g;
  let match;
  while ((match = regex.exec(headerStr)) !== null) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return params;
}

export async function executeX402PaymentAndInvoke(targetUrl, promptText, onLog = null) {
  const notify = (type, payload) => {
    if (onLog) onLog(type, payload);
  };

  console.log(`\n💳 [x402 Executor] API 결제 및 호출 시작`);
  console.log(`   - 지갑 주소: ${payer.publicKey.toBase58()}`);
  console.log(`   - 타겟 URL: ${targetUrl}`);
  console.log(`   - 전달 프롬프트: "${promptText}"`);
  notify("payment_start", {
    wallet: payer.publicKey.toBase58(),
    targetUrl,
    prompt: promptText,
  });

  const requestPayload = { prompt: promptText };

  // 1차 POST 요청 (402 Challenge 수령)
  const res1 = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestPayload),
  });

  if (res1.ok) return await res1.json();
  if (res1.status !== 402) throw new Error(`HTTP Error: ${res1.status}`);

  notify("challenge_received", { status: 402 });

  // Challenge 파싱
  const authHeader = res1.headers.get("www-authenticate");
  if (!authHeader) throw new Error("WWW-Authenticate 헤더 없음");

  const headerParams = parseAuthHeader(authHeader);
  const rawRequestBase64 = headerParams.request;
  const normalizedBase64 = rawRequestBase64
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const requestBody = JSON.parse(
    Buffer.from(normalizedBase64, "base64").toString("utf-8"),
  );

  // Solana 온체인 트랜잭션 구성 (Splits 정산 포함)
  const tx = new Transaction();
  tx.recentBlockhash = requestBody.methodDetails.recentBlockhash;
  tx.feePayer = payer.publicKey;

  const mintPubkey = new PublicKey(requestBody.currency);
  const payerAta = await getAssociatedTokenAddress(mintPubkey, payer.publicKey);
  const decimals = requestBody.methodDetails?.decimals ?? 6;

  const totalAmount = BigInt(requestBody.amount);
  const splits = requestBody.methodDetails?.splits || requestBody.splits || [];
  let allocatedSplitsAmount = 0n;

  for (const split of splits) {
    const splitAmount = BigInt(split.amount);
    allocatedSplitsAmount += splitAmount;
    const splitRecipientAta = await getAssociatedTokenAddress(
      mintPubkey,
      new PublicKey(split.recipient),
    );
    tx.add(
      createTransferCheckedInstruction(
        payerAta,
        mintPubkey,
        splitRecipientAta,
        payer.publicKey,
        splitAmount,
        decimals,
      ),
    );
  }

  const remainingAmount = totalAmount - allocatedSplitsAmount;
  if (remainingAmount > 0n || splits.length === 0) {
    const mainRecipientAta = await getAssociatedTokenAddress(
      mintPubkey,
      new PublicKey(requestBody.recipient),
    );
    const amountToSend = remainingAmount > 0n ? remainingAmount : totalAmount;
    tx.add(
      createTransferCheckedInstruction(
        payerAta,
        mintPubkey,
        mainRecipientAta,
        payer.publicKey,
        amountToSend,
        decimals,
      ),
    );
  }

  // ---------------------------------------------------------
  // ⚡ 트랜잭션 서명 및 해시(Signature) 추출 로그
  // ---------------------------------------------------------
  tx.sign(payer);
  const signedTxBase64 = tx.serialize().toString("base64");
  const txHash = bs58.encode(tx.signatures[0].signature);
  const explorerUrl = `https://explorer.solana.com/tx/${txHash}?cluster=devnet`;

  console.log(`\n⚡ [온체인 트랜잭션 발생]`);
  console.log(`   🔗 트랜잭션 해시: ${txHash}`);
  console.log(`   🌐 Explorer 링크: ${explorerUrl}`);
  notify("transaction_signed", {
    txHash,
    explorerUrl,
    amount: requestBody.amount,
  });

  // Credential 구성 및 2차 호출
  const credentialObj = {
    challenge: {
      id: headerParams.id,
      intent: headerParams.intent || "charge",
      method: headerParams.method || "solana",
      realm: headerParams.realm,
      request: rawRequestBase64,
      expires: headerParams.expires,
      description: requestBody.description,
    },
    payload: { type: "transaction", transaction: signedTxBase64 },
  };

  const credentialBase64 = Buffer.from(JSON.stringify(credentialObj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  console.log(`🚀 [2차 API 요청] 결제 Credential 전송 중...`);
  notify("credential_sending", {});

  const res2 = await fetch(targetUrl, {
    method: "POST",
    headers: {
      Authorization: `Payment ${credentialBase64}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestPayload),
  });

  if (!res2.ok) throw new Error(`2차 요청 실패: ${await res2.text()}`);
  const finalResult = await res2.json();
  notify("agent_response", finalResult);
  return finalResult;
}

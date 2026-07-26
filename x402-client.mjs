import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import bs58 from "bs58";
import fs from "fs";

// -------------------------------------------------------------
// 1. 설정 및 외부 파일 로드
// -------------------------------------------------------------
const CALLER_JSON_PATH = "/Users/minsik/development/SOL_DEV/caller.json";
const TESTLINK_TXT_PATH =
  "/Users/minsik/development/SOL_DEV/testlink_prompt.txt";

if (!fs.existsSync(CALLER_JSON_PATH)) {
  throw new Error(`지갑 파일이 존재하지 않습니다: ${CALLER_JSON_PATH}`);
}
const secretKeyArray = JSON.parse(fs.readFileSync(CALLER_JSON_PATH, "utf-8"));
const secretKey = Uint8Array.from(secretKeyArray);
const payer = Keypair.fromSecretKey(secretKey);

if (!fs.existsSync(TESTLINK_TXT_PATH)) {
  throw new Error(`테스트 링크 파일이 존재하지 않습니다: ${TESTLINK_TXT_PATH}`);
}
const TARGET_URL = fs.readFileSync(TESTLINK_TXT_PATH, "utf-8").trim();

if (!TARGET_URL) {
  throw new Error(`testlink.txt 파일이 비어 있습니다.`);
}

const DEVNET_RPC = "https://api.devnet.solana.com";
const connection = new Connection(DEVNET_RPC, "confirmed");

// -------------------------------------------------------------
// 2. 헤더 파싱 유틸리티 함수
// -------------------------------------------------------------
function parseAuthHeader(headerStr) {
  const params = {};
  const regex = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g;
  let match;
  while ((match = regex.exec(headerStr)) !== null) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return params;
}

// -------------------------------------------------------------
// 3. x402 (HTTP 402) 자동 결제 및 에이전트 호출 함수
// -------------------------------------------------------------
async function invokeX402Agent(targetUrl) {
  console.log(`\n==================================================`);
  console.log(`[1/4] 1차 API 요청 전송...`);
  console.log(`     지갑 주소: ${payer.publicKey.toBase58()}`);
  console.log(`     타겟 URL: ${targetUrl}`);
  console.log(`==================================================`);

  // Step 1: 1차 HTTP 요청 (402 Challenge 수령)
  const res1 = await fetch(targetUrl);
  console.log(`📡 [1차 응답 상태]: HTTP ${res1.status}`);

  if (res1.status === 402) {
    console.log("🔒 [2/4] HTTP 402 Challenge 수신. 정산 규격 파싱 중...\n");
  } else if (res1.ok) {
    console.log("ℹ️ 결제가 필요 없는 엔드포인트입니다.");
    const data = await res1.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  } else {
    const errorText = await res1.text();
    throw new Error(`1차 API 요청 에러 (HTTP ${res1.status}): ${errorText}`);
  }

  // Step 2: WWW-Authenticate 헤더 추출 및 파싱
  const authHeader = res1.headers.get("www-authenticate");
  if (!authHeader) {
    const errBody = await res1.text();
    throw new Error(
      `WWW-Authenticate 헤더가 응답에 없습니다. 응답 내용: ${errBody}`,
    );
  }

  console.log("🔍 [디버그] 수신된 원본 WWW-Authenticate 헤더:");
  console.log(`   ${authHeader}\n`);

  const headerParams = parseAuthHeader(authHeader);
  if (!headerParams.request) {
    throw new Error("Challenge 헤더 내 request 파라미터를 찾을 수 없습니다.");
  }

  const rawRequestBase64 = headerParams.request;

  // Base64 / Base64URL 디코딩
  const normalizedBase64 = rawRequestBase64
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const challengeJsonStr = Buffer.from(normalizedBase64, "base64").toString(
    "utf-8",
  );
  const requestBody = JSON.parse(challengeJsonStr);

  const decimals = requestBody.methodDetails?.decimals ?? 6;

  // ---------------------------------------------------------
  // 🔍 [평문 출력 1] 헤더 및 디코딩된 결제 챌린지 원문
  // ---------------------------------------------------------
  console.log("========= 📄 [결제 요청 스펙 (Challenge) 평문] =========");
  console.log(
    "1. 헤더 파라미터 (Header Params):",
    JSON.stringify(headerParams, null, 2),
  );
  console.log(
    "2. 디코딩된 Request 본문 (Decoded Request Body):",
    JSON.stringify(requestBody, null, 2),
  );
  console.log("=======================================================\n");

  // Step 3: Solana USDC TransferChecked 트랜잭션 구성 (Splits + Remaining Recipient)
  const tx = new Transaction();
  tx.recentBlockhash = requestBody.methodDetails.recentBlockhash;
  tx.feePayer = payer.publicKey;

  const mintPubkey = new PublicKey(requestBody.currency);
  const payerAta = await getAssociatedTokenAddress(mintPubkey, payer.publicKey);

  const totalAmount = BigInt(requestBody.amount);
  const splits = requestBody.methodDetails?.splits || requestBody.splits || [];
  let allocatedSplitsAmount = 0n;

  // 1. Splits 목록에 지정된 수취인들에게 전송 인스트럭션 추가
  if (splits.length > 0) {
    console.log(`💡 분할 정산(Splits) 목록 ${splits.length}개 처리 중...`);
    for (const split of splits) {
      const splitAmount = BigInt(split.amount);
      allocatedSplitsAmount += splitAmount;

      const splitRecipientPubkey = new PublicKey(split.recipient);
      const splitRecipientAta = await getAssociatedTokenAddress(
        mintPubkey,
        splitRecipientPubkey,
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
      console.log(
        `   - Split 수취: ${split.recipient} (${splitAmount} minimal unit)`,
      );
    }
  }

  // 2. 남은 금액(총액 - Splits 합계)을 메인 Recipient(게이트웨이)로 전송
  const remainingAmount = totalAmount - allocatedSplitsAmount;
  if (remainingAmount > 0n || splits.length === 0) {
    const mainRecipientPubkey = new PublicKey(requestBody.recipient);
    const mainRecipientAta = await getAssociatedTokenAddress(
      mintPubkey,
      mainRecipientPubkey,
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
    console.log(
      `   - 게이트웨이 정산: ${requestBody.recipient} (${amountToSend} minimal unit)`,
    );
  }

  tx.sign(payer);
  const signedTxBase64 = tx.serialize().toString("base64");

  // 트랜잭션 해시(Signature) 추출 및 출력
  const txHash = bs58.encode(tx.signatures[0].signature);

  console.log("\n✍️ [3/4] 온체인 결제 트랜잭션(transferChecked) 서명 완료!");
  console.log(`     트랜잭션 해시: ${txHash}`);
  console.log(
    `     익스플로러 링크: https://explorer.solana.com/tx/${txHash}?cluster=devnet\n`,
  );

  // Step 4: 규격에 맞춘 Credential JSON 생성 및 2차 요청
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
    payload: {
      type: "transaction",
      transaction: signedTxBase64,
    },
  };

  // ---------------------------------------------------------
  // 🔍 [평문 출력 2] 게이트웨이로 보낼 결제 증명(Credential) 평문
  // ---------------------------------------------------------
  console.log("========= 💳 [제출용 Payment Credential 평문] =========");
  console.log(JSON.stringify(credentialObj, null, 2));
  console.log("=======================================================\n");

  const credentialBase64 = Buffer.from(JSON.stringify(credentialObj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  console.log("[4/4] 2차 API 요청 전송 (결제 Credential 포함)...");
  const res2 = await fetch(targetUrl, {
    method: "GET",
    headers: {
      Authorization: `Payment ${credentialBase64}`,
    },
  });

  if (!res2.ok) {
    const errText = await res2.text();
    throw new Error(`요청 실패 (HTTP status ${res2.status}): ${errText}`);
  }

  const result = await res2.json();
  console.log("\n🎉 [성공] 에이전트 최종 응답:");
  console.log(JSON.stringify(result, null, 2));
}

// -------------------------------------------------------------
// 4. 실행
// -------------------------------------------------------------
invokeX402Agent(TARGET_URL).catch((err) => {
  console.error("❌ 오류 발생:", err.message);
});

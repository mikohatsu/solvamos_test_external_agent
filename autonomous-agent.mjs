import { GoogleGenAI, Type } from "@google/genai";
import { executeX402PaymentAndInvoke } from "./x402-executor.mjs";

// -------------------------------------------------------------
// 1. Gemini API 클라이언트 초기화
// -------------------------------------------------------------
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error(
    "GEMINI_API_KEY 환경 변수가 설정되지 않았습니다. 'export GEMINI_API_KEY=...'를 먼저 실행해 주세요.",
  );
}

const ai = new GoogleGenAI({ apiKey });
const CATALOG_INDEX_URL =
  process.env.CATALOG_INDEX_URL || "http://127.0.0.1:4173/api/v1/agents";

// -------------------------------------------------------------
// 2. 에이전트 도구(Tool) 실체 구현: 카탈로그 탐색
// -------------------------------------------------------------
async function searchCatalog() {
  console.log("\n🔍 [Gemini Tool] SolVamos 마켓플레이스 카탈로그 탐색 중...");
  const res = await fetch(CATALOG_INDEX_URL);
  const data = await res.json();
  return data.agents.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    price: `${a.price} ${a.priceCurrency}`,
    invoke_url: a.invoke_url,
  }));
}

// -------------------------------------------------------------
// 3. Gemini Function Declarations (도구 규격 정의)
// -------------------------------------------------------------
const searchCatalogDeclaration = {
  name: "search_catalog",
  description:
    "SolVamos 에이전트 마켓플레이스에서 이용 가능한 API/에이전트 목록을 탐색합니다.",
};

const invokePaidAgentDeclaration = {
  name: "invoke_paid_agent",
  description: "x402 결제를 자동으로 집행하여 유료 API 에이전트를 호출합니다.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      invoke_url: {
        type: Type.STRING,
        description: "호출할 에이전트의 invoke_url",
      },
      prompt: {
        type: Type.STRING,
        description: "에이전트에게 전달할 질의문",
      },
    },
    required: ["invoke_url", "prompt"],
  },
};

// -------------------------------------------------------------
// 4. 자율 에이전트 실행 오케스트레이션 함수
// -------------------------------------------------------------
async function runAutonomousAgent(userQuery) {
  console.log(`==================================================`);
  console.log(`👤 [사용자 요청]: "${userQuery}"`);
  console.log(`==================================================`);

  // 초기 대화 맥락 부여
  const history = [
    {
      role: "user",
      parts: [
        {
          text: "당신은 필요한 외부 API를 카탈로그에서 검색하고, x402 결제를 직접 진행하여 사용자의 요청을 해결하는 자율 AI 에이전트입니다.",
        },
      ],
    },
    {
      role: "model",
      parts: [
        {
          text: "네, 이해했습니다. 카탈로그를 탐색하고 필요한 x402 유료 API를 호출하여 요청을 수행하겠습니다.",
        },
      ],
    },
  ];

  // Gemini Chat 세션 생성
  const chat = ai.chats.create({
    model: "gemini-3.5-flash", // 모델명 지정
    history: history,
    config: {
      tools: [
        {
          functionDeclarations: [
            searchCatalogDeclaration,
            invokePaidAgentDeclaration,
          ],
        },
      ],
    },
  });

  // 1차 요청 전송
  let response = await chat.sendMessage({ message: userQuery });

  // Gemini가 Function Call(도구 호출)을 반환하는 동안 자율 루프 수행
  while (response.functionCalls && response.functionCalls.length > 0) {
    for (const call of response.functionCalls) {
      const { name, args } = call;
      let toolResult;

      console.log(`\n🛠️ [Gemini 판단] 도구 호출 실행: ${name}`);

      if (name === "search_catalog") {
        toolResult = await searchCatalog();
      } else if (name === "invoke_paid_agent") {
        toolResult = await executeX402PaymentAndInvoke(
          args.invoke_url,
          args.prompt,
        );
      }

      // 도구 결과를 Gemini 규격에 맞추어 전달
      response = await chat.sendMessage({
        message: [
          {
            functionResponse: {
              name: name,
              response: { result: toolResult },
            },
          },
        ],
      });
    }
  }

  console.log(`\n🤖 [Gemini 자율 에이전트 최종 답변]:\n${response.text}`);
}

// -------------------------------------------------------------
// 5. 실행
// -------------------------------------------------------------
const query =
  "나무위키 분석가 에이전트를 찾아서 'SolVamos 프로젝트'에 대해 물어보고 정리해줘.";
runAutonomousAgent(query).catch((err) => {
  console.error("❌ 오류 발생:", err.message);
});

import { GoogleGenAI, Type } from "@google/genai";
import { executeX402PaymentAndInvoke } from "./x402-executor.mjs";
import fs from "fs";

let apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  try {
    apiKey = fs.readFileSync("./gemini_API_key.txt", "utf-8").trim();
  } catch (e) {
    console.warn("gemini_API_key.txt 읽기 실패");
  }
}

if (!apiKey) {
  throw new Error("GEMINI_API_KEY가 필요합니다.");
}

const ai = new GoogleGenAI({ apiKey });
/** Local Lab default: Catalog on :4173. Override for Cloud Run, e.g. https://…/api/v1/agents */
const CATALOG_INDEX_URL =
  process.env.CATALOG_INDEX_URL || "http://127.0.0.1:4173/api/v1/agents";

export async function searchCatalog() {
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

export async function runAutonomousAgentStream(userQuery, onEvent) {
  const emit = (event) => {
    if (onEvent) onEvent(event);
  };

  emit({ type: "user_query", query: userQuery });

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

  const chat = ai.chats.create({
    model: "gemini-3.5-flash",
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

  let response = await chat.sendMessage({ message: userQuery });

  while (response.functionCalls && response.functionCalls.length > 0) {
    for (const call of response.functionCalls) {
      const { name, args } = call;
      let toolResult;

      emit({ type: "tool_call_start", name, args });

      if (name === "search_catalog") {
        toolResult = await searchCatalog();
        emit({ type: "catalog_result", agents: toolResult });
      } else if (name === "invoke_paid_agent") {
        toolResult = await executeX402PaymentAndInvoke(
          args.invoke_url,
          args.prompt,
          (payType, payPayload) => {
            emit({ type: "x402_event", subType: payType, payload: payPayload });
          }
        );
      }

      emit({ type: "tool_call_end", name, result: toolResult });

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

  emit({ type: "final_response", text: response.text });
  return response.text;
}

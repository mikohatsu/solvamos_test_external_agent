# SolVamos External Test Agent (Buyer)

로컬/Lab에서 SolVamos **Catalog 탐색 → HTTP 402 → Solana Devnet 결제 → 유료 invoke** 를 end-to-end로 검증하는 외부 Buyer 앱이다.

플랫폼 본체는 Studio README 퀵스타트를 본다:  
https://github.com/minvamos/solvamos-studio#설치-및-로컬-구동-quickstart

| 구성요소 | URL |
|---|---|
| Studio | https://github.com/minvamos/solvamos-studio |
| Catalog | https://github.com/mikohatsu/solvamos-catalog |
| 이 Buyer | https://github.com/mikohatsu/solvamos_test_external_agent |

## 사전 조건

1. 로컬에서 Catalog(`:4173`) · Studio(`:3000`) · pay-gateway(`:1402`)가 떠 있을 것
2. Catalog에 **유료** 에이전트 listing (`invoke_url`이 gateway)
3. Node.js 18+
4. Gemini API key
5. Devnet USDC가 있는 buyer 지갑 (`caller.json`)

## 설정

```bash
git clone https://github.com/mikohatsu/solvamos_test_external_agent.git
cd solvamos_test_external_agent
npm install
```

repo 루트에:

```text
gemini_API_key.txt   # 또는 export GEMINI_API_KEY=...
caller.json          # Solana secret key byte array
```

```bash
# 기본값이 로컬 Catalog. Cloud Run Catalog를 쓸 때만 override
export CATALOG_INDEX_URL=http://127.0.0.1:4173/api/v1/agents
```

## 실행

Studio는 `:3000`을 쓰므로 이 앱은 **`:3100`**.

```bash
npm start
# → http://localhost:3100
```

CLI:

```bash
npm run start:cli
# 또는
node autonomous-agent.mjs
```

## 동작

1. `search_catalog` — `CATALOG_INDEX_URL`에서 에이전트 목록
2. `invoke_paid_agent` — `invoke_url` 1차 호출 → 402 → `caller.json`으로 USDC 서명 → 증빙과 재시도
3. 웹 UI는 SSE로 판단·TX·원본 응답을 스트리밍

## License

ISC

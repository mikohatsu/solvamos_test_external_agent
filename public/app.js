// SolVamos Autonomous Agent Web UI Logic

document.addEventListener("DOMContentLoaded", () => {
  // Initialize Lucide Icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  const agentForm = document.getElementById("agentForm");
  const queryInput = document.getElementById("queryInput");
  const submitBtn = document.getElementById("submitBtn");
  const logTimeline = document.getElementById("logTimeline");
  const emptyState = document.getElementById("emptyState");
  const clearLogsBtn = document.getElementById("clearLogsBtn");
  const agentStatusBadge = document.getElementById("agentStatusBadge");
  const resultSection = document.getElementById("resultSection");
  const resultMarkdown = document.getElementById("resultMarkdown");
  const presetChips = document.querySelectorAll(".chip");

  let eventSource = null;
  let hasRawResponseDisplayed = false;

  // Preset Chips Click Event
  presetChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      queryInput.value = chip.dataset.query;
      queryInput.focus();
    });
  });

  // Clear Logs
  clearLogsBtn.addEventListener("click", () => {
    logTimeline.innerHTML = "";
    logTimeline.appendChild(emptyState);
    emptyState.style.display = "flex";
    resultSection.classList.add("hidden");
    resultMarkdown.innerHTML = "";
    hasRawResponseDisplayed = false;
    setStatus("idle", "대기 중");
  });

  // Form Submit
  agentForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const query = queryInput.value.trim();
    if (!query) return;

    startAgentExecution(query);
  });

  function setStatus(type, text) {
    agentStatusBadge.className = `status-indicator status-${type}`;
    agentStatusBadge.textContent = text;
  }

  function getTimeString() {
    const d = new Date();
    return d.toTimeString().split(" ")[0];
  }

  function appendLogItem(className, iconName, title, contentHtml) {
    if (emptyState && emptyState.parentNode) {
      emptyState.style.display = "none";
    }

    const item = document.createElement("div");
    item.className = `timeline-item ${className}`;
    item.innerHTML = `
      <div class="event-header">
        <div class="event-title">
          <i data-lucide="${iconName}"></i>
          <span>${title}</span>
        </div>
        <span class="event-time">${getTimeString()}</span>
      </div>
      <div class="event-content">${contentHtml}</div>
    `;

    logTimeline.appendChild(item);
    logTimeline.scrollTop = logTimeline.scrollHeight;

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  function startAgentExecution(query) {
    if (eventSource) {
      eventSource.close();
    }

    // UI state update
    hasRawResponseDisplayed = false;
    submitBtn.disabled = true;
    submitBtn.querySelector(".btn-text").textContent = "실행 중...";
    setStatus("running", "실행 중");
    resultSection.classList.add("hidden");

    appendLogItem("user_query", "user-check", "사용자 요청 발송", escapeHtml(query));

    const encodedQuery = encodeURIComponent(query);
    eventSource = new EventSource(`/api/agent/stream?query=${encodedQuery}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleAgentEvent(data);
      } catch (err) {
        console.error("SSE Parse Error:", err);
      }
    };

    eventSource.onerror = (err) => {
      console.error("SSE Error:", err);
      eventSource.close();
      setStatus("error", "연결 오류");
      submitBtn.disabled = false;
      submitBtn.querySelector(".btn-text").textContent = "에이전트 실행";
    };
  }

  function handleAgentEvent(event) {
    switch (event.type) {
      case "user_query":
        // Already rendered
        break;

      case "tool_call_start":
        if (event.name === "search_catalog") {
          appendLogItem(
            "tool_call",
            "search",
            "Gemini 판단: SolVamos 카탈로그 탐색 시작",
            "마켓플레이스에 등록된 유료 API/에이전트 목록을 조회합니다."
          );
        } else if (event.name === "invoke_paid_agent") {
          appendLogItem(
            "tool_call",
            "shield-alert",
            "Gemini 판단: x402 유료 API 에이전트 호출 판단",
            `<strong>URL:</strong> ${escapeHtml(event.args.invoke_url)}<br/>` +
              `<strong>전달 프롬프트:</strong> "${escapeHtml(event.args.prompt)}"`
          );
        }
        break;

      case "catalog_result":
        if (Array.isArray(event.agents)) {
          let rowsHtml = `<table class="catalog-table"><thead><tr><th>에이전트 ID</th><th>이름</th><th>설명</th><th>가격</th></tr></thead><tbody>`;
          event.agents.forEach((a) => {
            rowsHtml += `<tr><td><code>${escapeHtml(a.id)}</code></td><td><strong>${escapeHtml(a.name)}</strong></td><td>${escapeHtml(a.description)}</td><td><span class="badge">${escapeHtml(a.price)}</span></td></tr>`;
          });
          rowsHtml += `</tbody></table>`;
          appendLogItem("catalog", "list", "카탈로그 검색 완료", rowsHtml);
        }
        break;

      case "x402_event":
        handleX402SubEvent(event.subType, event.payload);
        break;

      case "final_response":
        setStatus("success", "완료");
        appendLogItem(
          "catalog",
          "check-circle",
          "에이전트 실행 작업 완료",
          "1차 원본 응답(Raw Response) 수신이 완료되었습니다."
        );

        // 만약 1차 응답(Raw Response)이 없는 일반 질의응답인 경우 Gemini 요약 표출
        if (!hasRawResponseDisplayed && window.marked && event.text) {
          resultMarkdown.innerHTML = window.marked.parse(event.text);
          resultSection.classList.remove("hidden");
          resultSection.scrollIntoView({ behavior: "smooth" });
        }
        break;

      case "done":
        if (eventSource) eventSource.close();
        submitBtn.disabled = false;
        submitBtn.querySelector(".btn-text").textContent = "에이전트 실행";
        break;

      case "error":
        setStatus("error", "오류 발생");
        appendLogItem("error", "alert-triangle", "에이전트 오류 발생", escapeHtml(event.message));
        if (eventSource) eventSource.close();
        submitBtn.disabled = false;
        submitBtn.querySelector(".btn-text").textContent = "에이전트 실행";
        break;

      default:
        console.log("Unhandled event:", event);
    }
  }

  function handleX402SubEvent(subType, payload) {
    switch (subType) {
      case "payment_start":
        appendLogItem(
          "x402_tx",
          "wallet",
          "x402 온체인 결제 핸드셰이크 개시",
          `<strong>지갑 주소:</strong> <code>${payload.wallet}</code><br/><strong>대상 URL:</strong> ${payload.targetUrl}`
        );
        break;

      case "challenge_received":
        appendLogItem(
          "x402_tx",
          "lock",
          "HTTP 402 Challenge 수령 (Paywall 확인)",
          "서버로부터 HTTP 402 Payment Required 요구 및 결제 규격 스펙을 확인했습니다."
        );
        break;

      case "transaction_signed":
        const txLink = `<a href="${payload.explorerUrl}" target="_blank" class="tx-link"><i data-lucide="external-link"></i> Solana Explorer에서 확인 (Devnet)</a>`;
        appendLogItem(
          "x402_tx",
          "coins",
          "Solana 온체인 결제 서명 완료 및 트랜잭션 발생",
          `<strong>트랜잭션 해시:</strong> <code>${payload.txHash}</code><br/>${txLink}`
        );
        break;

      case "credential_sending":
        appendLogItem(
          "x402_tx",
          "send",
          "x402 Payment Credential 전송 중",
          "서명된 트랜잭션을 포함한 Authorization Header로 2차 API 요청을 전송합니다."
        );
        break;

      case "agent_response":
        appendLogItem(
          "x402_tx",
          "sparkles",
          "유료 에이전트 서비스 1차 원본 응답 수신",
          `<pre style="background:rgba(0,0,0,0.3); padding:8px; border-radius:6px; font-size:0.8rem; overflow-x:auto;">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`
        );

        // 1차 원본 응답(Raw Response)을 하단 결과 섹션에 직접 표출
        displayRawResponse(payload);
        break;
    }
  }

  function displayRawResponse(payload) {
    hasRawResponseDisplayed = true;

    const rawFormattedJson = JSON.stringify(payload, null, 2);

    let htmlContent = `
      <div style="margin-bottom: 12px; font-size: 0.9rem; color: var(--text-muted);">
        <i data-lucide="file-code" style="vertical-align: middle; margin-right: 4px; color: var(--success);"></i> 
        호출한 외부 유료 API 에이전트로부터 전달받은 <strong>1차 원본 응답 데이터 (Raw Response Payload)</strong>입니다:
      </div>
      <pre style="background: rgba(10, 12, 20, 0.9); border: 1px solid var(--border-highlight); padding: 18px; border-radius: var(--radius-md); font-family: monospace; font-size: 0.92rem; color: #a7f3d0; overflow-x: auto; max-height: 550px; line-height: 1.5;"><code>${escapeHtml(rawFormattedJson)}</code></pre>
    `;

    // raw response에 result, text, content 등의 본문 필드가 있는 경우 별도 가독성 프리뷰 추가
    const mainText = payload.result || payload.text || payload.content || payload.message || payload.answer;
    if (mainText && typeof mainText === "string") {
      htmlContent += `
        <div style="margin-top: 24px; margin-bottom: 8px; font-weight: 600; color: var(--text-main); display: flex; align-items: center; gap: 6px;">
          <i data-lucide="align-left" style="color: var(--primary);"></i> 원본 텍스트 추출 (Direct Extracted Content):
        </div>
        <div style="background: rgba(255, 255, 255, 0.03); border-left: 4px solid var(--primary); padding: 16px 20px; border-radius: var(--radius-sm); color: var(--text-main); font-size: 0.95rem; white-space: pre-wrap; line-height: 1.6;">${escapeHtml(mainText)}</div>
      `;
    }

    resultMarkdown.innerHTML = htmlContent;
    resultSection.classList.remove("hidden");
    resultSection.scrollIntoView({ behavior: "smooth" });

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
});

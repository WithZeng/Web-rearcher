import type { PipelineMessage } from './api';

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8000';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;

export function connectPipeline(
  taskId: string,
  onMessage: (msg: PipelineMessage) => void,
  onClose?: () => void,
): { close: () => void } {
  let attempts = 0;
  let closed = false;
  let currentWs: WebSocket | null = null;

  function connect() {
    const ws = new WebSocket(`${WS_BASE}/ws/pipeline/${taskId}`);
    currentWs = ws;

    ws.onmessage = (event) => {
      attempts = 0;
      try {
        const raw = JSON.parse(event.data);

        if (raw.type === 'activity') {
          onMessage({ type: 'activity', activityText: raw.text });
          return;
        }

        const msg: PipelineMessage = {
          type: raw.stage === 'done' ? 'complete' : raw.stage === 'error' ? 'error' : 'stage',
          stage: raw.stage,
          progress: raw.progress,
          message: raw.label || raw.detail,
          data: {
            papers_found: raw.papers_found,
            papers_passed: raw.papers_passed,
            rows_extracted: raw.rows_extracted,
          },
        };
        onMessage(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (closed) {
        onClose?.();
        return;
      }
      attempts++;
      if (attempts <= MAX_RECONNECT_ATTEMPTS) {
        onMessage({
          type: 'activity',
          activityText: `连接断开，正在重连 (${attempts}/${MAX_RECONNECT_ATTEMPTS})...`,
        });
        setTimeout(connect, RECONNECT_DELAY_MS);
      } else {
        onMessage({
          type: 'error',
          message: '与服务器的连接已断开，任务可能仍在后台运行。请刷新页面或检查服务器状态。',
        });
        onClose?.();
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  connect();

  return {
    close: () => {
      closed = true;
      currentWs?.close();
    },
  };
}

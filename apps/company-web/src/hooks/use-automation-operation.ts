import { useCallback, useEffect, useRef, useState } from 'react';
import { api, problemMessage, type Schema } from '../api';

type AutomationOperation = Schema<'AutomationOperation'>;

type Options = {
  scopeKey: string;
  onSucceeded: (operation: AutomationOperation) => void;
  pollIntervalMs?: number;
};

export function useAutomationOperation({ scopeKey, onSucceeded, pollIntervalMs = 400 }: Options) {
  const [operation, setOperation] = useState<AutomationOperation | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const generationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const onSucceededRef = useRef(onSucceeded);
  onSucceededRef.current = onSucceeded;

  const cancel = useCallback((clearState = true) => {
    generationRef.current += 1;
    activeRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (clearState) {
      setOperation(null);
      setErrorMessage(null);
      setIsStarting(false);
    }
  }, []);

  useEffect(() => {
    cancel();
    return () => cancel(false);
  }, [cancel, scopeKey]);

  const start = useCallback(
    async (createOperation: () => Promise<AutomationOperation>) => {
      if (activeRef.current) return;

      const generation = generationRef.current + 1;
      generationRef.current = generation;
      activeRef.current = true;
      setOperation(null);
      setErrorMessage(null);
      setIsStarting(true);

      const isCurrent = () => generationRef.current === generation;

      const accept = (nextOperation: AutomationOperation) => {
        if (!isCurrent()) return;
        setOperation(nextOperation);

        if (nextOperation.status === 'succeeded') {
          activeRef.current = false;
          onSucceededRef.current(nextOperation);
          return;
        }
        if (nextOperation.status === 'failed' || nextOperation.status === 'cancelled') {
          activeRef.current = false;
          setErrorMessage(
            nextOperation.error?.message ??
              `自动化操作已${nextOperation.status === 'failed' ? '失败' : '取消'}。`,
          );
          return;
        }

        timerRef.current = setTimeout(() => void poll(nextOperation.id), pollIntervalMs);
      };

      const poll = async (operationId: string) => {
        try {
          const nextOperation = await api.automationOperation(operationId);
          accept(nextOperation);
        } catch (error) {
          if (!isCurrent()) return;
          activeRef.current = false;
          setErrorMessage(problemMessage(error));
        }
      };

      try {
        const initialOperation = await createOperation();
        if (!isCurrent()) return;
        setIsStarting(false);
        accept(initialOperation);
      } catch (error) {
        if (!isCurrent()) return;
        activeRef.current = false;
        setIsStarting(false);
        setErrorMessage(problemMessage(error));
      }
    },
    [pollIntervalMs],
  );

  return {
    cancel,
    errorMessage,
    isRunning: isStarting || operation?.status === 'queued' || operation?.status === 'running',
    operation,
    start,
  };
}

export function automationStatusLabel(status: Schema<'AutomationRunStatus'>) {
  if (status === 'queued') return '已排队';
  if (status === 'running') return '运行中';
  if (status === 'succeeded') return '已完成';
  if (status === 'failed') return '失败';
  return '已取消';
}

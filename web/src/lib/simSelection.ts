export interface SmsSim {
  subscriptionId: number;
  isActive: boolean;
  isDefaultSms: boolean;
}

export function selectSmsSim<T extends SmsSim>(items: T[], savedId: number | null): T | undefined {
  const active = items.filter(item => item.isActive);
  if (savedId !== null) return active.find(item => item.subscriptionId === savedId);
  return active.find(item => item.isDefaultSms) ?? active[0];
}

export interface SmsSim {
  subscriptionId: number;
  isActive: boolean;
  isDefaultSms: boolean;
  sendCapable?: boolean;
}

export function selectSmsSim<T extends SmsSim>(items: T[], savedId: number | null): T | undefined {
  const active = items.filter(item => item.isActive && item.sendCapable !== false);
  if (savedId !== null) return active.find(item => item.subscriptionId === savedId);
  return active.find(item => item.isDefaultSms) ?? active[0];
}

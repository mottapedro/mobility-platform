export interface PushPayload {
  title:   string;
  message: string;
  data?:   Record<string, string>;
}

export interface IPushNotificationService {
  send(recipientUserId: string, payload: PushPayload): Promise<void>;
}

class ConsolePushNotificationService implements IPushNotificationService {
  async send(recipientUserId: string, payload: PushPayload): Promise<void> {
    console.log(`[PUSH→${recipientUserId}] ${payload.title}: ${payload.message}`);
  }
}

export const pushService: IPushNotificationService = new ConsolePushNotificationService();

export declare class HealthController {
  get(): {
    status: string;
    uptimeSec: number;
    timestamp: string;
  };
  metrics(): {
    success: boolean;
    data: {
      uptimeSec: number;
    };
    timestamp: string;
  };
}

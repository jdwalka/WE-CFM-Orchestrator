/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OAUTH_PORTAL_URL?: string;
  readonly VITE_APP_ID?: string;
  readonly VITE_FRONTEND_FORGE_API_KEY?: string;
  readonly VITE_FRONTEND_FORGE_API_URL?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_MEASUREMENT_ID?: string;
  readonly [key: string]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  electron?: {
    invoke?: (channel: string, ...args: any[]) => Promise<any>;
  };
  wecryp?: {
    onTelemetry?: (callback: (data: unknown) => void) => void;
    runInference?: (prompt: string, context: Record<string, unknown>) => Promise<any>;
    syncDrive?: (payload: Record<string, unknown>) => Promise<any>;
    recoverDrive?: (options?: Record<string, unknown>) => Promise<any>;
    cloudStatus?: () => Promise<any>;
    cloudSqlStatus?: (options?: Record<string, unknown>) => Promise<any>;
    testCloudSql?: () => Promise<any>;
    tideForecast?: (payload: Record<string, unknown>) => Promise<any>;
  };
}
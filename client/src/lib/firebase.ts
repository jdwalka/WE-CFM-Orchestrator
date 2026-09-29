import { getAnalytics } from "firebase/analytics";
import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  setPersistence,
  type Auth,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

export const hasRequiredConfig = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.appId
);

export let firebaseApp: FirebaseApp | null = null;
export let firebaseAuth: Auth | null = null;
export let googleAuthProvider: GoogleAuthProvider | null = null;

if (hasRequiredConfig) {
  firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
  firebaseAuth = getAuth(firebaseApp);
  googleAuthProvider = new GoogleAuthProvider();
  googleAuthProvider.setCustomParameters({ prompt: "select_account" });

  if (typeof window !== "undefined") {
    try {
      getAnalytics(firebaseApp);
    } catch (_) {
      // Analytics can fail in desktop/runtime contexts where GA is unavailable.
    }
  }
}

export async function ensureFirebaseAuth(): Promise<Auth> {
  if (!firebaseAuth) {
    throw new Error("Firebase client config missing (check VITE_FIREBASE_* variables)");
  }
  await setPersistence(firebaseAuth, browserLocalPersistence);
  return firebaseAuth;
}

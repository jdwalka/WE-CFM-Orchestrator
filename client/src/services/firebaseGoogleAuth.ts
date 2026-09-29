import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";

import {
  ensureFirebaseAuth,
  firebaseAuth,
  googleAuthProvider,
  hasRequiredConfig as hasFirebaseClientConfig,
} from "@/lib/firebase";

export { hasFirebaseClientConfig };

function isPopupFlowError(error: unknown): boolean {
  const code = String((error as { code?: string } | null)?.code || "");
  return (
    code === "auth/popup-blocked" ||
    code === "auth/cancelled-popup-request" ||
    code === "auth/operation-not-supported-in-this-environment"
  );
}

export async function signInWithGoogle(): Promise<void> {
  if (!hasFirebaseClientConfig) {
    throw new Error("Firebase Google auth is not configured.");
  }
  if (!googleAuthProvider) {
    throw new Error("Google auth provider is unavailable.");
  }

  const auth = await ensureFirebaseAuth();
  try {
    await signInWithPopup(auth, googleAuthProvider);
  } catch (error) {
    if (isPopupFlowError(error)) {
      await signInWithRedirect(auth, googleAuthProvider);
      return;
    }
    throw error;
  }
}

export async function signOutGoogle(): Promise<void> {
  const auth = await ensureFirebaseAuth();
  await signOut(auth);
}

export function subscribeGoogleUser(
  callback: (user: User | null) => void
): () => void {
  if (!hasFirebaseClientConfig || !firebaseAuth || !googleAuthProvider) {
    callback(null);
    return () => {};
  }

  return onAuthStateChanged(firebaseAuth, callback);
}

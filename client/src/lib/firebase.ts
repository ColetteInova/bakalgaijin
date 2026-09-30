import { initializeApp, type FirebaseApp } from "firebase/app";
import {
    getAuth,
    GoogleAuthProvider,
    onAuthStateChanged,
    signInWithPopup,
    type User,
} from "firebase/auth";

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

let app: FirebaseApp | null = null;

export function initFirebase(config: FirebaseClientConfig): boolean {
  if (!config.apiKey || !config.projectId || !config.appId) return false;
  if (!app) {
    app = initializeApp({
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      appId: config.appId,
    });
  }
  return true;
}

export function isFirebaseReady(): boolean {
  return app !== null;
}

export async function signInWithGoogle(): Promise<User> {
  if (!app) throw new Error("Firebase não configurado");
  const auth = getAuth(app);
  await signInWithPopup(auth, new GoogleAuthProvider());
  if (!auth.currentUser) throw new Error("Login com Google falhou");
  return auth.currentUser;
}

export function watchAuth(callback: (user: User | null) => void): () => void {
  if (!app) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(getAuth(app), callback);
}

export async function getIdToken(): Promise<string | null> {
  if (!app) return null;
  const user = getAuth(app).currentUser;
  if (!user) return null;
  return user.getIdToken();
}

export function signOutFirebase(): void {
  if (app) void getAuth(app).signOut();
}

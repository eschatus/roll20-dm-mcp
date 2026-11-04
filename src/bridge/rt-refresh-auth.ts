// Sign in from a stored Firebase refresh token, so a restart doesn't need a fresh custom token.
//
// The Auth SDK has no public call that takes a raw refresh token, but it does restore a signed-in
// user from its persistence layer on startup. So a one-shot persistence hands it a user holding
// the refresh token and an already-expired access token, and the SDK's own refresh does the rest.
// The field list is what UserImpl._fromJSON asserts (firebase 12.14): internal, so a Firebase
// upgrade that breaks this fails here, loudly, as an auth/internal-error.
//
// A token Firebase refuses makes the SDK clear the user, which is how rejection shows up here.
import { type FirebaseApp } from "firebase/app";
import { initializeAuth, type Persistence, type User } from "firebase/auth";

function seededPersistence(key: string, user: unknown): Persistence {
  const store = new Map<string, unknown>([[key, user]]);
  return class {
    static type = "NONE" as const;
    type = "NONE" as const;
    async _isAvailable() { return true; }
    async _set(k: string, v: unknown) { store.set(k, v); }
    async _get(k: string) { return store.get(k) ?? null; }
    async _remove(k: string) { store.delete(k); }
    _addListener() {}
    _removeListener() {}
  } as unknown as Persistence;
}

export async function restoreRefreshUser(app: FirebaseApp, refreshToken: string): Promise<User> {
  const { apiKey } = app.options;
  const seed = {
    uid: "pending-refresh", // Replaced by the real uid when the SDK reloads the account.
    emailVerified: false,
    isAnonymous: false,
    apiKey,
    appName: app.name,
    stsTokenManager: { refreshToken, accessToken: "x.e30.x", expirationTime: 1 },
  };
  const auth = initializeAuth(app, { persistence: seededPersistence(`firebase:authUser:${apiKey}:${app.name}`, seed) });
  await auth.authStateReady();
  if (!auth.currentUser) {
    throw Object.assign(new Error("Firebase refused the refresh token."), { code: "auth/invalid-refresh-token" });
  }
  return auth.currentUser;
}

// Wraps the template's Prisma session storage so access and refresh tokens are
// encrypted at rest (NFR Security). The library still handles expiring offline
// tokens and refresh; we only transform the stored values.
import type { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { decrypt, encrypt } from "./crypto.server";

type AnySession = Session & { refreshToken?: string };

function transform<T extends AnySession | undefined>(s: T, fn: (v: string) => string): T {
  if (!s) return s;
  const copy = Object.assign(Object.create(Object.getPrototypeOf(s)), s) as AnySession;
  if (copy.accessToken) copy.accessToken = fn(copy.accessToken);
  if (copy.refreshToken) copy.refreshToken = fn(copy.refreshToken);
  return copy as T;
}

export class EncryptedSessionStorage implements SessionStorage {
  constructor(private readonly inner: SessionStorage) {}

  storeSession(session: Session) {
    return this.inner.storeSession(transform(session as AnySession, encrypt));
  }
  async loadSession(id: string) {
    return transform((await this.inner.loadSession(id)) as AnySession | undefined, decrypt);
  }
  deleteSession(id: string) {
    return this.inner.deleteSession(id);
  }
  deleteSessions(ids: string[]) {
    return this.inner.deleteSessions(ids);
  }
  async findSessionsByShop(shop: string) {
    const list = await this.inner.findSessionsByShop(shop);
    return list.map((s) => transform(s as AnySession, decrypt));
  }
}

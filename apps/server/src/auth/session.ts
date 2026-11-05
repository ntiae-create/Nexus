import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
export const OWNER_ID = "00000000-0000-4000-8000-000000000004" as const;
export interface SessionPayload { readonly ownerId: typeof OWNER_ID; readonly issuedAt: number; readonly expiresAt: number; readonly jti: string; }
export interface SessionConfig { readonly secret: string; readonly ownerPassword: string; readonly ttlSeconds?: number; }
const DEFAULT_TTL = 604800;
function requireSecret(v: string | undefined, name: string): string { const s=v?.trim(); if(!s||s.length<16) throw new Error(`${name} must be at least 16 characters`); return s; }
export function loadSessionConfig(env: NodeJS.ProcessEnv = process.env): SessionConfig {
 const secret=requireSecret(env.NEXUS_SESSION_SECRET,"NEXUS_SESSION_SECRET"), ownerPassword=requireSecret(env.NEXUS_OWNER_PASSWORD,"NEXUS_OWNER_PASSWORD");
 const raw=env.NEXUS_SESSION_TTL_SECONDS; const ttl=raw === undefined ? DEFAULT_TTL : Number(raw);
 if(!Number.isSafeInteger(ttl)||ttl<60||ttl>31_536_000) throw new Error("NEXUS_SESSION_TTL_SECONDS must be an integer from 60 to 31536000");
 return {secret,ownerPassword,ttlSeconds:ttl};
}
function digest(p:string,s:string):Buffer { return scryptSync(p,createHmac("sha256",s).update("nexus-owner-password-salt").digest(),32); }
export function verifyOwnerPassword(candidate:string,c:SessionConfig):boolean { try{return timingSafeEqual(digest(candidate,c.secret),digest(c.ownerPassword,c.secret));}catch{return false;} }
function sign(v:string,s:string):string{return createHmac("sha256",s).update(v).digest("base64url");}
export function issueSessionToken(config:SessionConfig):{token:string;payload:SessionPayload}{const now=Math.floor(Date.now()/1000);const payload:SessionPayload={ownerId:OWNER_ID,issuedAt:now,expiresAt:now+(config.ttlSeconds??DEFAULT_TTL),jti:randomBytes(16).toString("hex")};const b=Buffer.from(JSON.stringify(payload)).toString("base64url");return{token:`${b}.${sign(b,config.secret)}`,payload};}
export function verifySessionToken(token:string,config:SessionConfig):SessionPayload|null {
 try { if(typeof token!=="string"||token.length>2048)return null; const parts=token.split(".");if(parts.length!==2)return null;const [b,sig]=parts;if(!b||!/^[A-Za-z0-9_-]+$/.test(b)||!/^[A-Za-z0-9_-]{43}$/.test(sig))return null;
 const expected=Buffer.from(sign(b,config.secret));const actual=Buffer.from(sig);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
 const p=JSON.parse(Buffer.from(b,"base64url").toString("utf8")) as Record<string,unknown>;const now=Math.floor(Date.now()/1000);
 if(Object.keys(p).sort().join(",")!=="expiresAt,issuedAt,jti,ownerId"||p.ownerId!==OWNER_ID||!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||typeof p.issuedAt!=="number"||typeof p.expiresAt!=="number"||p.issuedAt>now||p.expiresAt<=now||p.expiresAt<=p.issuedAt||p.expiresAt-p.issuedAt>31_536_000||typeof p.jti!=="string"||!/^[a-f0-9]{32}$/.test(p.jti))return null;
 return p as unknown as SessionPayload;
 }catch{return null;}
}
export function extractBearerToken(h:string|undefined):string|null{if(!h)return null;const m=/^Bearer\s+([^\s]+)$/i.exec(h.trim());return m?.[1]??null;}

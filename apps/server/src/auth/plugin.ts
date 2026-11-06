import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { extractBearerToken, issueSessionToken, loadSessionConfig, verifyOwnerPassword, verifySessionToken, OWNER_ID, type SessionConfig, type SessionPayload } from "./session.js";
import type { AuthStore } from "./store.js";
import { postgresAuthStore } from "./postgres-store.js";
declare module "fastify" { interface FastifyRequest { session?: SessionPayload; } interface FastifyInstance { sessionConfig?: SessionConfig; authStore?: AuthStore; } }
export interface AuthPluginOptions { config?: SessionConfig; store?: AuthStore; disabled?: boolean; }
function tryLoadConfig():SessionConfig|undefined{try{return loadSessionConfig();}catch{return undefined;}}
export async function authPlugin(app:FastifyInstance, options:AuthPluginOptions={}):Promise<void>{
 const config=options.disabled?undefined:(options.config??tryLoadConfig());const store=options.store??postgresAuthStore;
 if(config)app.decorate("sessionConfig",config);app.decorate("authStore",store);
 app.post("/v1/auth/login",async(request,reply)=>{if(!config)return reply.code(503).send({error:{code:"AUTH_NOT_CONFIGURED",message:"Authentication is not configured",retryable:false},timestamp:new Date().toISOString()});
 const body=request.body as {password?:unknown}|null;const password=typeof body?.password==="string"?body.password:"";
 if(!password||password.length>1024)return reply.code(400).send({error:{code:"INVALID_REQUEST",message:"password is required",retryable:false},timestamp:new Date().toISOString()});
 if(!verifyOwnerPassword(password,config)){const allowed=await store.recordFailure();return reply.code(allowed?401:429).send({error:{code:allowed?"UNAUTHORIZED":"LOGIN_LOCKED",message:allowed?"Invalid credentials":"Login temporarily locked",retryable:!allowed},timestamp:new Date().toISOString()});}
 await store.clearFailures();const {token,payload}=issueSessionToken(config);return{token,tokenType:"Bearer",expiresAt:new Date(payload.expiresAt*1000).toISOString(),owner:{userId:OWNER_ID}};});
 app.get("/v1/auth/me",{preHandler:requireAuth},async(req)=>({owner:{userId:req.session!.ownerId},session:{issuedAt:new Date(req.session!.issuedAt*1000).toISOString(),expiresAt:new Date(req.session!.expiresAt*1000).toISOString()}}));
 app.post("/v1/auth/logout",{preHandler:requireAuth},async(req)=>{await store.revoke(req.session!.jti,req.session!.expiresAt);return{ok:true};});
}
Object.assign(authPlugin, { [Symbol.for("skip-override")]: true });
export async function requireAuth(request:FastifyRequest,reply:FastifyReply):Promise<void>{const c=request.server.sessionConfig;if(!c){reply.code(503).send({error:{code:"AUTH_NOT_CONFIGURED",message:"Authentication is not configured",retryable:false},timestamp:new Date().toISOString()});return;}const raw=extractBearerToken(request.headers.authorization);const payload=raw?verifySessionToken(raw,c):null;if(!payload||await request.server.authStore!.isRevoked(payload.jti)){reply.code(401).send({error:{code:"UNAUTHORIZED",message:"Invalid, expired, or revoked session",retryable:false},timestamp:new Date().toISOString()});return;}request.session=payload;}

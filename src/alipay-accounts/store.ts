import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { IdentityTransaction } from "../database/identity-store.ts";
import { normalizeProviderIdentity } from "../ledger/model.ts";
import { RuntimeSecretCipher, type EncryptedSecret } from "../settings/crypto.ts";
import {
  parseProviderApplicationPrivateKey, parseProviderKeys, parsePlatformPublicKey,
  publicKeyFingerprint, providerEndpoint,
  type ProviderApplicationKeyMaterial, type ProviderApplicationKeyChange, type ProviderSettings,
} from "../settings/model.ts";
import { SettingsError, type SettingsAuditContext } from "../settings/store.ts";
import { SettingsFieldError } from "../settings/validation.ts";
import { AlipayAccountError, alipayAccountIdSchema, type AlipayAccountSnapshot, type AlipayAccountView } from "./model.ts";
import { collectionCodeError } from "../shared/collection-code.ts";
import { verifyAlipayAccountSecrets } from "./integrity.ts";

type Int = number | bigint;
interface AccountRow {
  account_id:string; revision:Int; name:string; enabled:Int; code_payload:string|null;
  environment:"PRODUCTION"|"SANDBOX"; app_id:string|null; provider_account_key:string|null; created_at:Int; updated_at:Int;
}
interface SecretRow {secret_version:Int;cipher_version:Int;nonce:Uint8Array;ciphertext:Uint8Array;authentication_tag:Uint8Array;secret_fingerprint:string}
interface ChangeRow {
  change_id:string;account_id:string;requested_revision:Int;base_fingerprint:string;new_fingerprint:string;
  provider_account_key:string|null;app_id:string|null;environment:"PRODUCTION"|"SANDBOX"|null;
  state:"PENDING"|"ACTIVATED"|"DISCARDED";created_at:Int;finished_revision:Int|null;
  cipher_version:Int;nonce:Uint8Array;ciphertext:Uint8Array;authentication_tag:Uint8Array;
}
export interface AccountWrite {
  readonly name:string;readonly enabled:boolean;readonly code_payload:string|null;readonly environment:"PRODUCTION"|"SANDBOX";
  readonly app_id:string|null;readonly platform_public_key?:string|null|undefined;readonly private_key?:string|undefined;
}
function encrypted(row: Pick<SecretRow,"cipher_version"|"nonce"|"ciphertext"|"authentication_tag">):EncryptedSecret {
  return {cipherVersion:Number(row.cipher_version) as 1,nonce:Buffer.from(row.nonce),ciphertext:Buffer.from(row.ciphertext),authenticationTag:Buffer.from(row.authentication_tag)};
}

export class AlipayAccountStore {
  readonly #database:AppDatabase;
  readonly #cipher:RuntimeSecretCipher;
  constructor(database:AppDatabase,masterKey:Uint8Array) {
    this.#database=database;
    this.#cipher=new RuntimeSecretCipher(masterKey,database.instanceId());
  }
  available():boolean { return this.#database.read(db=>Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='alipay_accounts' AND type='table'").get())); }
  verifySecrets():void {this.#database.read(db=>verifyAlipayAccountSecrets(db,this.#cipher));}
  snapshots():AlipayAccountSnapshot[] {
    return this.#database.read(db=>(db.prepare("SELECT * FROM alipay_accounts ORDER BY created_at,account_id").all() as unknown as AccountRow[]).map(row=>this.#snapshot(db,row)));
  }
  snapshot(id:string):AlipayAccountSnapshot {return this.#database.read(db=>this.#snapshot(db,this.#row(db,id)));}
  keyChange(id:string,changeId:string):ProviderApplicationKeyChange|null {
    return this.#database.read(db=>{
      const row=db.prepare("SELECT * FROM alipay_application_key_changes WHERE account_id=? AND change_id=?").get(id,changeId) as unknown as ChangeRow|undefined;
      return row?this.#change(row):null;
    });
  }
  assertProviderSwitchAllowed(id:string):void {
    this.#database.read(db=>{
      if(db.prepare("SELECT 1 FROM payment_orders WHERE alipay_account_id=? AND checkout_status='OPEN' AND payment_status='UNPAID' LIMIT 1").get(id)) {
        throw new SettingsError("provider_switch_blocked","这个账号仍有未支付订单，请先处理这些订单再更换应用。");
      }
      if(db.prepare("SELECT 1 FROM ingest_runs AS run JOIN alipay_account_generations AS generation USING(provider_account_key) WHERE generation.account_id=? AND run.status='RUNNING' LIMIT 1").get(id)) {
        throw new SettingsError("provider_switch_blocked","这个账号正在查账，请稍后重试。");
      }
    });
  }
  list():AlipayAccountView[] { return this.snapshots().map(account=>this.view(account.id)); }
  generationViews():Array<{provider_account_key:string;app_id:string;environment:"PRODUCTION"|"SANDBOX";activated_at:string;active:boolean}> {
    return this.#database.read(db=>{
      const rows=db.prepare(`SELECT generation.provider_account_key,binding.external_account_id,binding.provider_endpoint,
        generation.created_at,account.provider_account_key AS current_key FROM alipay_account_generations AS generation
        JOIN provider_account_bindings AS binding USING(provider_account_key) JOIN alipay_accounts AS account USING(account_id)
        ORDER BY generation.created_at,generation.provider_account_key`).all() as Array<{provider_account_key:string;external_account_id:string;provider_endpoint:string;created_at:Int;current_key:string|null}>;
      return rows.map(row=>({provider_account_key:row.provider_account_key,app_id:row.external_account_id,
        environment:row.provider_endpoint===providerEndpoint("SANDBOX")?"SANDBOX":"PRODUCTION",
        activated_at:new Date(Number(row.created_at)).toISOString(),active:row.current_key===row.provider_account_key}));
    });
  }
  view(id:string):AlipayAccountView {
    return this.#database.read(db=>{
      const account=this.#snapshot(db,this.#row(db,id));
      const pending=account.pendingApplicationKey;
      const sites=this.#sites(db,id);
      const check=db.prepare("SELECT ok,checked_at,message FROM alipay_account_checks WHERE account_id=? AND revision=?").get(id,account.revision) as {ok:Int;checked_at:Int;message:string}|undefined;
      return {
        id,revision:account.revision,name:account.name,enabled:account.enabled,code_payload:account.codePayload,
        environment:account.environment,app_id:account.appId,platform_public_key:account.platformPublicKey,
        provider_account_key:account.providerAccountKey,configured:account.configured,
        application_public_key:account.applicationKey?.uploadPublicKey??null,application_key_fingerprint:account.applicationKey?.fingerprint??null,
        pending_application_key:pending?.key?{change_id:pending.changeId,public_key:pending.key.uploadPublicKey,fingerprint:pending.newFingerprint,
          app_id:pending.appId!,environment:pending.environment!,created_at:new Date(pending.createdAt).toISOString()}:null,
        sites,deletable:sites.length===0&&!this.#hasHistory(db,id),
        last_check:check?{ok:Number(check.ok)===1,checked_at:new Date(Number(check.checked_at)).toISOString(),message:check.message}:null,
        created_at:new Date(account.createdAt).toISOString(),updated_at:new Date(account.updatedAt).toISOString(),
      };
    });
  }
  create(input:AccountWrite,audit:SettingsAuditContext):AlipayAccountView {
    const id="alipay_"+randomUUID();
    this.#database.write(db=>{
      this.#assertUnique(db,id,input.environment,input.app_id);
      const now=Date.now();
      const providerKey=input.app_id?this.#newBinding(db,input,now):null;
      db.prepare("INSERT INTO alipay_accounts VALUES (?,0,?,?,?,?,?,?,?,?)").run(id,input.name,Number(input.enabled),input.code_payload,input.environment,input.app_id,providerKey,now,now);
      if(providerKey)db.prepare("INSERT INTO alipay_account_generations VALUES (?,?,?)").run(providerKey,id,now);
      this.#saveCredentials(db,id,input,null,now);
      this.#snapshot(db,this.#row(db,id));
      this.#audit(db,id,audit,"alipay_account.created",0,{name:input.name},now);
    });
    return this.view(id);
  }
  update(id:string,revision:number,input:AccountWrite,audit:SettingsAuditContext):AlipayAccountView {
    this.#database.write(db=>{
      const current=this.#snapshot(db,this.#revision(db,id,revision));
      this.#assertUnique(db,id,input.environment,input.app_id);
      const identityChanged=current.appId!==input.app_id||current.environment!==input.environment;
      if(identityChanged&&current.pendingApplicationKey) throw new SettingsError("provider_application_key_change_pending","请先启用或放弃待启用密钥，再切换应用。");
      if(current.provider&&input.private_key&&!identityChanged&&parseProviderApplicationPrivateKey(input.private_key).fingerprint!==current.applicationKey?.fingerprint) {
        throw new SettingsError("provider_application_key_rotation_not_supported","请通过更换应用密钥流程更新正在使用的私钥。");
      }
      const now=Math.max(Date.now(),current.updatedAt);
      const providerKey=identityChanged?(input.app_id?this.#newBinding(db,input,now):null):current.providerAccountKey;
      db.prepare("UPDATE alipay_accounts SET revision=revision+1,name=?,enabled=?,code_payload=?,environment=?,app_id=?,provider_account_key=?,updated_at=? WHERE account_id=?").run(
        input.name,Number(input.enabled),input.code_payload,input.environment,input.app_id,providerKey,now,id,
      );
      if(identityChanged&&providerKey)db.prepare("INSERT INTO alipay_account_generations VALUES (?,?,?)").run(providerKey,id,now);
      this.#saveCredentials(db,id,input,identityChanged?null:current,now);
      if(identityChanged&&input.platform_public_key===undefined) db.prepare("DELETE FROM alipay_account_secrets WHERE account_id=? AND secret_name='public_key'").run(id);
      this.#snapshot(db,this.#row(db,id));
      this.#audit(db,id,audit,"alipay_account.updated",revision+1,{name:input.name,enabled:input.enabled},now);
    });
    return this.view(id);
  }
  remove(id:string,revision:number,audit:SettingsAuditContext):void {
    this.#database.write(db=>{
      this.#revision(db,id,revision);
      if(this.#sites(db,id).length||this.#hasHistory(db,id)) throw new AlipayAccountError("alipay_account_in_use","这个账号仍被网站或收款记录使用，不能删除。可以暂停接收新订单。");
      db.prepare("DELETE FROM alipay_account_checks WHERE account_id=?").run(id);
      db.prepare("DELETE FROM alipay_application_key_changes WHERE account_id=?").run(id);
      db.prepare("DELETE FROM alipay_account_secrets WHERE account_id=?").run(id);
      db.prepare("DELETE FROM alipay_account_generations WHERE account_id=?").run(id);
      db.prepare("DELETE FROM alipay_accounts WHERE account_id=?").run(id);
      this.#audit(db,id,audit,"alipay_account.deleted",revision,{},Date.now());
    });
  }
  saveInitialKey(id:string,revision:number,key:ProviderApplicationKeyMaterial,audit:SettingsAuditContext):AlipayAccountView {
    this.#database.write(db=>{
      const current=this.#snapshot(db,this.#revision(db,id,revision));
      if(current.applicationKey) throw new SettingsError("provider_application_key_change_conflict","此账号已有应用密钥，请使用更换应用密钥。");
      const now=Math.max(Date.now(),current.updatedAt);
      this.#secret(db,id,"private_key",key.privateKeyPem,key.fingerprint,now);
      this.#advance(db,id,now);
      this.#audit(db,id,audit,"alipay_account.application_key_generated",revision+1,{fingerprint:key.fingerprint},now);
    });
    return this.view(id);
  }
  prepareKeyChange(id:string,revision:number,changeId:string,baseFingerprint:string,key:ProviderApplicationKeyMaterial,audit:SettingsAuditContext):AlipayAccountView {
    this.#database.write(db=>{
      const current=this.#snapshot(db,this.#revision(db,id,revision));
      if(current.applicationKey?.fingerprint!==baseFingerprint) throw new SettingsError("provider_application_key_change_conflict","应用密钥已变化，请刷新后重试。");
      if(current.pendingApplicationKey) throw new SettingsError("provider_application_key_change_pending","此账号已有待启用密钥。");
      if(db.prepare("SELECT 1 FROM alipay_application_key_changes WHERE change_id=?").get(changeId)) throw new SettingsError("provider_application_key_change_conflict","这次换钥操作已经处理，请刷新后重试。");
      const now=Math.max(Date.now(),current.updatedAt);
      const active=current.provider!==null;
      const cipher=active?this.#cipher.encrypt(`alipay:${id}:key_change:${changeId}`,1,key.privateKeyPem):null;
      db.prepare("INSERT INTO alipay_application_key_changes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        changeId,id,revision,baseFingerprint,key.fingerprint,current.providerAccountKey,current.appId,current.environment,active?"PENDING":"ACTIVATED",
        cipher?.cipherVersion??null,cipher?.nonce??null,cipher?.ciphertext??null,cipher?.authenticationTag??null,now,active?null:revision+1,active?null:now,
      );
      if(!active) this.#secret(db,id,"private_key",key.privateKeyPem,key.fingerprint,now);
      this.#advance(db,id,now);
      this.#audit(db,id,audit,active?"alipay_account.application_key_prepared":"alipay_account.application_key_regenerated",revision+1,{change_id:changeId,fingerprint:key.fingerprint},now);
    });
    return this.view(id);
  }
  finishKeyChange(id:string,revision:number,changeId:string,provider:ProviderSettings|null,audit:SettingsAuditContext):AlipayAccountView {
    this.#database.write(db=>{
      const current=this.#snapshot(db,this.#revision(db,id,revision));
      const pending=current.pendingApplicationKey;
      if(!pending?.key||pending.changeId!==changeId||pending.providerAccountKey!==current.providerAccountKey||pending.baseFingerprint!==current.applicationKey?.fingerprint||pending.appId!==current.appId||pending.environment!==current.environment) {
        throw new SettingsError("provider_application_key_change_conflict","待启用密钥已经变化，请刷新后重试。");
      }
      if(provider&&(provider.applicationKeyFingerprint!==pending.newFingerprint||provider.appId!==current.appId||provider.environment!==current.environment)) throw new SettingsError("provider_application_key_change_conflict","验证结果与待启用密钥不匹配。");
      const now=Math.max(Date.now(),current.updatedAt);
      if(provider) {
        this.#secret(db,id,"private_key",pending.key.privateKeyPem,pending.key.fingerprint,now);
        this.#secret(db,id,"public_key",provider.publicKeyPem,provider.platformKeyFingerprint,now);
      }
      db.prepare("UPDATE alipay_application_key_changes SET state=?,cipher_version=NULL,nonce=NULL,ciphertext=NULL,authentication_tag=NULL,finished_revision=?,finished_at=? WHERE change_id=? AND account_id=?").run(provider?"ACTIVATED":"DISCARDED",revision+1,now,changeId,id);
      this.#advance(db,id,now);
      this.#audit(db,id,audit,provider?"alipay_account.application_key_activated":"alipay_account.application_key_discarded",revision+1,{change_id:changeId},now);
    });
    return this.view(id);
  }
  recordCheck(id:string,revision:number,ok:boolean,message:string,now:number):void {
    this.#database.write(db=>{
      const account=db.prepare("SELECT revision FROM alipay_accounts WHERE account_id=?").get(id) as {revision:Int}|undefined;
      if(!account||Number(account.revision)!==revision)return;
      db.prepare("INSERT INTO alipay_account_checks VALUES (?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,ok=excluded.ok,checked_at=excluded.checked_at,message=excluded.message").run(id,revision,Number(ok),now,message);
    });
  }
  timing():Omit<Parameters<typeof parseProviderKeys>[0],"environment"|"appId"|"privateKey"|"publicKey"> {
    return this.#database.read(db=>this.#timing(db));
  }
  #timing(db:DatabaseSync) {
    const row=db.prepare("SELECT * FROM runtime_configuration WHERE singleton_key=1").get()!;
    return {timeoutMilliseconds:Number(row.provider_timeout_milliseconds),scanIntervalMilliseconds:Number(row.provider_scan_interval_milliseconds),
      activeScanIntervalMilliseconds:Number(row.provider_active_scan_interval_milliseconds),minimumScanIntervalMilliseconds:Number(row.provider_minimum_scan_interval_milliseconds),
      safetyLagMilliseconds:Number(row.provider_safety_lag_milliseconds),maximumSuccessAgeMilliseconds:Number(row.provider_maximum_success_age_milliseconds)};
  }
  #row(db:DatabaseSync,id:string):AccountRow {
    alipayAccountIdSchema.parse(id);
    const row=db.prepare("SELECT * FROM alipay_accounts WHERE account_id=?").get(id) as unknown as AccountRow|undefined;
    if(!row)throw new AlipayAccountError("alipay_account_not_found","没有找到这个支付宝账号。");
    return row;
  }
  #revision(db:DatabaseSync,id:string,revision:number):AccountRow {
    const row=this.#row(db,id);
    if(Number(row.revision)!==revision)throw new AlipayAccountError("alipay_account_revision_conflict","账号设置已变化，请刷新后重试。");
    return row;
  }
  #snapshot(db:DatabaseSync,row:AccountRow):AlipayAccountSnapshot {
    const privatePem=this.#readSecret(db,row.account_id,"private_key");
    const publicPem=this.#readSecret(db,row.account_id,"public_key");
    const applicationKey=privatePem?parseProviderApplicationPrivateKey(privatePem):null;
    const provider=privatePem&&publicPem&&row.app_id&&row.provider_account_key?parseProviderKeys({
      ...this.#timing(db),environment:row.environment,appId:row.app_id,privateKey:privatePem,publicKey:publicPem,
    }):null;
    return {id:row.account_id,revision:Number(row.revision),name:row.name,enabled:Number(row.enabled)===1,codePayload:row.code_payload,
      environment:row.environment,appId:row.app_id,platformPublicKey:publicPem,providerAccountKey:row.provider_account_key,provider,
      configured:provider!==null&&row.code_payload!==null&&collectionCodeError(row.code_payload)===null,applicationKey,pendingApplicationKey:this.#pending(db,row.account_id),
      createdAt:Number(row.created_at),updatedAt:Number(row.updated_at)};
  }
  #pending(db:DatabaseSync,id:string):ProviderApplicationKeyChange|null {
    const row=db.prepare("SELECT * FROM alipay_application_key_changes WHERE account_id=? AND state='PENDING'").get(id) as unknown as ChangeRow|undefined;
    if(!row)return null;
    return this.#change(row);
  }
  #change(row:ChangeRow):ProviderApplicationKeyChange {
    let key:ProviderApplicationKeyMaterial|null=null;
    if(row.state==="PENDING") {
      const plaintext=this.#cipher.decrypt(`alipay:${row.account_id}:key_change:${row.change_id}`,1,encrypted(row));
      try{key=parseProviderApplicationPrivateKey(plaintext.toString("utf8"));}finally{plaintext.fill(0);}
      if(key.fingerprint!==row.new_fingerprint)throw new Error("Alipay pending application key fingerprint is invalid");
    }
    return {changeId:row.change_id,requestedRevision:Number(row.requested_revision),baseFingerprint:row.base_fingerprint,newFingerprint:row.new_fingerprint,
      providerAccountKey:row.provider_account_key,appId:row.app_id,environment:row.environment,state:row.state,key,createdAt:Number(row.created_at),finishedRevision:row.finished_revision===null?null:Number(row.finished_revision)};
  }
  #readSecret(db:DatabaseSync,id:string,purpose:"private_key"|"public_key"):string|null {
    const row=db.prepare("SELECT * FROM alipay_account_secrets WHERE account_id=? AND secret_name=?").get(id,purpose) as unknown as SecretRow|undefined;
    if(!row)return null;
    const plaintext=this.#cipher.decrypt(`alipay:${id}:${purpose}`,Number(row.secret_version),encrypted(row));
    try {
      const pem=plaintext.toString("utf8");
      const fingerprint=purpose==="private_key"?parseProviderApplicationPrivateKey(pem).fingerprint:publicKeyFingerprint(parsePlatformPublicKey(pem).publicKey);
      if(fingerprint!==row.secret_fingerprint)throw new Error("Alipay account key fingerprint is invalid");
      return pem;
    }finally{plaintext.fill(0);}
  }
  #secret(db:DatabaseSync,id:string,purpose:"private_key"|"public_key",value:string,fingerprint:string,now:number):void {
    const current=db.prepare("SELECT secret_version FROM alipay_account_secrets WHERE account_id=? AND secret_name=?").get(id,purpose) as {secret_version:Int}|undefined;
    const version=Number(current?.secret_version??0)+1;
    const cipher=this.#cipher.encrypt(`alipay:${id}:${purpose}`,version,value);
    db.prepare(`INSERT INTO alipay_account_secrets VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,secret_name) DO UPDATE SET
      secret_version=excluded.secret_version,cipher_version=excluded.cipher_version,nonce=excluded.nonce,ciphertext=excluded.ciphertext,
      authentication_tag=excluded.authentication_tag,secret_fingerprint=excluded.secret_fingerprint,updated_at=excluded.updated_at`).run(
      id,purpose,version,cipher.cipherVersion,cipher.nonce,cipher.ciphertext,cipher.authenticationTag,fingerprint,now,
    );
  }
  #saveCredentials(db:DatabaseSync,id:string,input:AccountWrite,current:AlipayAccountSnapshot|null,now:number):void {
    if(input.private_key) {
      const key=parseProviderApplicationPrivateKey(input.private_key);
      this.#secret(db,id,"private_key",key.privateKeyPem,key.fingerprint,now);
    }
    if(input.platform_public_key===null)db.prepare("DELETE FROM alipay_account_secrets WHERE account_id=? AND secret_name='public_key'").run(id);
    else if(input.platform_public_key!==undefined) {
      const key=parsePlatformPublicKey(input.platform_public_key);
      const fingerprint=publicKeyFingerprint(key.publicKey);
      const privatePem=input.private_key??current?.applicationKey?.privateKeyPem??this.#readSecret(db,id,"private_key");
      if(privatePem&&parseProviderApplicationPrivateKey(privatePem).fingerprint===fingerprint)throw new SettingsFieldError("platform_public_key","这是应用公钥，请改填支付宝提供的支付宝公钥。","platform public key cannot be the application's public key");
      this.#secret(db,id,"public_key",key.publicKeyPem,fingerprint,now);
    }
  }
  #newBinding(db:DatabaseSync,input:AccountWrite,now:number):string {
    // Bind identity as soon as an App ID is saved; credentials may still be incomplete.
    const key="alipay:"+randomUUID();
    const identity=normalizeProviderIdentity({providerAccountKey:key,providerKind:"alipay",endpoint:providerEndpoint(input.environment),externalAccountId:input.app_id!});
    db.prepare("INSERT INTO provider_account_bindings VALUES (?,?,?,?,?,?,?)").run(key,identity.providerKind,identity.endpoint,identity.externalAccountId,identity.identityFingerprintVersion,identity.identityFingerprint,now);
    return key;
  }
  #advance(db:DatabaseSync,id:string,now:number):void {db.prepare("UPDATE alipay_accounts SET revision=revision+1,updated_at=? WHERE account_id=?").run(now,id);}
  #assertUnique(db:DatabaseSync,id:string,environment:string,appId:string|null):void {
    if(appId&&db.prepare("SELECT 1 FROM alipay_accounts WHERE environment=? AND app_id=? AND account_id!=?").get(environment,appId,id)) throw new AlipayAccountError("alipay_account_app_conflict","这个应用已用于另一个支付宝账号，请勿重复添加。");
  }
  #sites(db:DatabaseSync,id:string):Array<{client_id:string;name:string}> {
    return db.prepare(`SELECT site.client_id,json_extract(site.configuration,'$.name') AS name FROM sites AS site
      WHERE site.deleted_at IS NULL AND EXISTS(SELECT 1 FROM json_each(site.configuration,'$.collection.accounts') AS account WHERE json_extract(account.value,'$.account_id')=?)
      ORDER BY site.created_at,site.client_id`).all(id) as Array<{client_id:string;name:string}>;
  }
  #hasHistory(db:DatabaseSync,id:string):boolean {
    return Boolean(db.prepare(`SELECT 1 FROM payment_orders WHERE alipay_account_id=? UNION ALL
      SELECT 1 FROM ledger_entries AS entry JOIN alipay_account_generations AS generation USING(provider_account_key) WHERE generation.account_id=? LIMIT 1`).get(id,id));
  }
  #audit(db:DatabaseSync,id:string,audit:SettingsAuditContext,action:string,revision:number,details:Record<string,unknown>,now:number):void {
    new IdentityTransaction(db).appendAudit({occurredAt:now,actorType:"ADMIN",actorId:audit.actorId,action,outcome:"SUCCESS",subjectType:"alipay_account",subjectId:id,
      requestId:audit.requestId,remoteAddressHash:audit.remoteAddressHash,details:{...details,revision}});
  }
}

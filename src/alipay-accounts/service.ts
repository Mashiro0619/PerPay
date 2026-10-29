import {
  generateProviderApplicationKey, parseProviderKeys, providerEndpoint, parsePlatformPublicKey, publicKeyFingerprint,
  regenerateProviderApplicationKeySchema, activateProviderApplicationKeySchema, applicationKeyChangeActionSchema,
  type RegenerateProviderApplicationKeyInput, type ActivateProviderApplicationKeyInput, type ApplicationKeyChangeActionInput,
} from "../settings/model.ts";
import { verifyProviderApplicationKey, type ProviderKeyVerifier, type ProviderKeyVerificationOptions } from "../settings/provider-key-verification.ts";
import { SettingsError, type SettingsAuditContext } from "../settings/store.ts";
import { AlipayAccountStore } from "./store.ts";
import {
  AlipayAccountError, createAlipayAccountInputSchema, updateAlipayAccountInputSchema, alipayAccountRevisionSchema,
  type CreateAlipayAccountInput, type UpdateAlipayAccountInput, type AlipayAccountSnapshot, type AlipayAccountView,
} from "./model.ts";

export interface AlipayAccountServiceOptions {
  readonly store:AlipayAccountStore;
  readonly onMutationStarted?:(accountId:string)=>void|Promise<void>;
  readonly onApplied?:(accountId:string)=>void|Promise<void>;
  readonly guardProviderSwitch?:(input:{current:AlipayAccountSnapshot;nextAppId:string|null;nextEndpoint:string})=>void|Promise<void>;
  readonly verifyProviderApplicationKey?:ProviderKeyVerifier;
}
export class AlipayAccountService {
  readonly #store:AlipayAccountStore;
  readonly #options:AlipayAccountServiceOptions;
  readonly #mutations=new Map<string,Promise<void>>();
  constructor(options:AlipayAccountServiceOptions){this.#store=options.store;this.#options=options;}
  store(){return this.#store;}
  list(){return this.#store.list();}
  get(id:string){return this.#store.view(id);}
  async create(input:CreateAlipayAccountInput,audit:SettingsAuditContext):Promise<AlipayAccountView>{
    const account=this.#store.create(createAlipayAccountInputSchema.parse(input),audit);
    await this.#options.onApplied?.(account.id);
    return account;
  }
  update(id:string,input:UpdateAlipayAccountInput,audit:SettingsAuditContext):Promise<AlipayAccountView>{
    return this.#exclusive(id,async()=>{
      const parsed=updateAlipayAccountInputSchema.parse(input);
      const current=this.#store.snapshot(id);
      this.#revision(current,parsed.revision);
      return this.#apply(id,async()=>{
        if(current.providerAccountKey&&(current.appId!==parsed.app_id||current.environment!==parsed.environment||parsed.platform_public_key===null)) {
          this.#store.assertProviderSwitchAllowed(id);
          await this.#options.guardProviderSwitch?.({current,nextAppId:parsed.app_id,nextEndpoint:providerEndpoint(parsed.environment)});
        }
        return this.#store.update(id,parsed.revision,parsed,audit);
      });
    });
  }
  remove(id:string,input:{revision:number},audit:SettingsAuditContext):Promise<void>{
    return this.#exclusive(id,async()=>{const parsed=alipayAccountRevisionSchema.parse(input);await this.#apply(id,()=>this.#store.remove(id,parsed.revision,audit));});
  }
  generateApplicationKey(id:string,input:{revision:number},audit:SettingsAuditContext):Promise<AlipayAccountView>{
    return this.#exclusive(id,async()=>{
      const parsed=alipayAccountRevisionSchema.parse(input);
      this.#revision(this.#store.snapshot(id),parsed.revision);
      const key=await generateProviderApplicationKey();
      return this.#apply(id,()=>this.#store.saveInitialKey(id,parsed.revision,key,audit));
    });
  }
  regenerateApplicationKey(id:string,input:RegenerateProviderApplicationKeyInput,audit:SettingsAuditContext):Promise<AlipayAccountView>{
    return this.#exclusive(id,async()=>{
      const parsed=regenerateProviderApplicationKeySchema.parse(input);
      const existing=this.#store.keyChange(id,parsed.change_id);
      if(existing) {
        if(existing.requestedRevision!==parsed.revision||existing.baseFingerprint!==parsed.base_fingerprint)throw new SettingsError("provider_application_key_change_conflict","这次换钥操作与原请求不一致。");
        return this.get(id);
      }
      this.#revision(this.#store.snapshot(id),parsed.revision);
      const key=await generateProviderApplicationKey();
      return this.#store.prepareKeyChange(id,parsed.revision,parsed.change_id,parsed.base_fingerprint,key,audit);
    });
  }
  activateApplicationKey(id:string,input:ActivateProviderApplicationKeyInput,audit:SettingsAuditContext,options:ProviderKeyVerificationOptions={}):Promise<AlipayAccountView>{
    return this.#exclusive(id,async()=>{
      const parsed=activateProviderApplicationKeySchema.parse(input);
      const current=this.#store.snapshot(id);
      const existing=this.#store.keyChange(id,parsed.change_id);
      if(existing?.state==="ACTIVATED"&&existing.finishedRevision===current.revision&&existing.finishedRevision===parsed.revision+1) {
        if(current.provider?.platformKeyFingerprint!==publicKeyFingerprint(parsePlatformPublicKey(parsed.platform_public_key).publicKey)) {
          throw new SettingsError("provider_application_key_change_conflict","这次启用请求与已保存的支付宝公钥不一致。");
        }
        return this.get(id);
      }
      this.#revision(current,parsed.revision);
      const pending=current.pendingApplicationKey;
      if(!pending?.key||pending.changeId!==parsed.change_id||!current.appId)throw new SettingsError("provider_application_key_change_conflict","没有找到这把待启用密钥，请刷新后重试。");
      const provider=parseProviderKeys({...this.#store.timing(),environment:current.environment,appId:current.appId,privateKey:pending.key.privateKeyPem,publicKey:parsed.platform_public_key});
      options.signal?.throwIfAborted();
      await (this.#options.verifyProviderApplicationKey??verifyProviderApplicationKey)(provider,options);
      options.signal?.throwIfAborted();
      return this.#apply(id,()=>{options.signal?.throwIfAborted();return this.#store.finishKeyChange(id,parsed.revision,parsed.change_id,provider,audit);});
    });
  }
  discardApplicationKey(id:string,input:ApplicationKeyChangeActionInput,audit:SettingsAuditContext):Promise<AlipayAccountView>{
    return this.#exclusive(id,async()=>{
      const parsed=applicationKeyChangeActionSchema.parse(input);
      const existing=this.#store.keyChange(id,parsed.change_id);
      const current=this.#store.snapshot(id);
      if(existing?.state==="DISCARDED"&&existing.finishedRevision===current.revision&&existing.finishedRevision===parsed.revision+1)return this.get(id);
      return this.#store.finishKeyChange(id,parsed.revision,parsed.change_id,null,audit);
    });
  }
  async check(id:string,options:ProviderKeyVerificationOptions={}):Promise<{ok:boolean;checked_at:string;message:string}>{
    const current=this.#store.snapshot(id);
    let ok=false,message="请先填写 App ID、支付宝公钥，并生成或导入应用私钥。";
    if(current.provider){
      try {await(this.#options.verifyProviderApplicationKey??verifyProviderApplicationKey)(current.provider,options);ok=true;message="已连接支付宝，账务明细查询正常。";}
      catch(error){message=error instanceof SettingsError?error.message.replace(/ 当前密钥未更换。$/u,""):"暂时无法连接支付宝，请稍后重试。";}
    }
    const now=Date.now();
    this.#store.recordCheck(id,current.revision,ok,message,now);
    return {ok,checked_at:new Date(now).toISOString(),message};
  }
  #revision(account:AlipayAccountSnapshot,revision:number):void{
    if(account.revision!==revision)throw new AlipayAccountError("alipay_account_revision_conflict","账号设置已变化，请刷新后重试。");
  }
  async #apply<T>(id:string,action:()=>T|Promise<T>):Promise<T>{
    let result:T;
    try {
      await this.#options.onMutationStarted?.(id);
      result=await action();
    } catch(error) {
      try{await this.#options.onApplied?.(id);}
      catch(restoreError){throw new AggregateError([error,restoreError],"Alipay account mutation and runtime restoration failed");}
      throw error;
    }
    await this.#options.onApplied?.(id);
    return result;
  }
  #exclusive<T>(id:string,action:()=>Promise<T>):Promise<T>{
    const previous=this.#mutations.get(id)??Promise.resolve();
    const result=previous.then(action);
    const settled=result.then(()=>undefined,()=>undefined);
    this.#mutations.set(id,settled);
    void settled.then(()=>{if(this.#mutations.get(id)===settled)this.#mutations.delete(id);});
    return result;
  }
}

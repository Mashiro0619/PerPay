import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSettingsService, RuntimeSettingsStore, SettingsError } from "../src/settings/index.ts";
import { AlipayAccountStore, AlipayAccountService, AlipayAccountError, type AlipayAccountView } from "../src/alipay-accounts/index.ts";
import { createLegacySettingsDatabase } from "./legacy-settings-fixture.ts";
import { createLocalBackup, restoreLocalBackup } from "../src/backup/repository.ts";
import { OrderService } from "../src/orders/service.ts";
import { keyMaster, privatePem, platformPem, nextPlatformPem, providerInput, keyAudit } from "./application-key-fixture.ts";

const code="https://qr.alipay.com/account_test";
const edit=(account:AlipayAccountView,patch:Record<string,unknown>={})=>({
  revision:account.revision,name:account.name,enabled:account.enabled,code_payload:account.code_payload,
  environment:account.environment,app_id:account.app_id,...patch,
});
async function withAccounts(test:(context:{db:AppDatabase;store:AlipayAccountStore;service:AlipayAccountService;directory:string})=>Promise<void>) {
  const directory=mkdtempSync(join(tmpdir(),"perpay-alipay-accounts-"));
  const db=await AppDatabase.open(join(directory,"state.sqlite3"));
  new RuntimeSettingsStore(db,keyMaster).initialize();
  const store=new AlipayAccountStore(db,keyMaster);
  const service=new AlipayAccountService({store,verifyProviderApplicationKey:async()=>undefined});
  try{await test({db,store,service,directory});}
  finally{db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())));rmSync(directory,{recursive:true,force:true});}
}
const configured=(service:AlipayAccountService,name:string,appId:string)=>service.create({
  name,app_id:appId,code_payload:code,private_key:privatePem,platform_public_key:platformPem,
},keyAudit());

describe("Alipay account configuration",()=>{
  it("starts empty and keeps an unfinished account without making it available for orders",async()=>{
    await withAccounts(async({db,store,service})=>{
      assert.deepEqual(service.list(),[]);
      let account=await service.create({name:"工作室"},keyAudit());
      assert.equal(account.configured,false);
      assert.equal(account.application_public_key,null);
      account=await service.generateApplicationKey(account.id,{revision:account.revision},keyAudit());
      assert.ok(account.application_public_key);
      assert.equal(account.configured,false);
      account=await service.update(account.id,edit(account,{app_id:"studio",platform_public_key:platformPem,code_payload:code}),keyAudit());
      assert.equal(account.configured,true);
      assert.equal(store.snapshot(account.id).provider!.appId,"studio");
      assert.equal(JSON.stringify(account).includes("PRIVATE KEY"),false);
      assert.equal(db.integrityCheck().ok,true);
    });
  });
  it("keeps revisions, pause state, keys, and duplicate application checks local to each account",async()=>{
    await withAccounts(async({db,store,service})=>{
      const first=await configured(service,"主账号","app-a");
      const second=await configured(service,"备用","app-b");
      const updated=await service.update(first.id,edit(first,{enabled:false,name:"暂停账号"}),keyAudit());
      assert.equal(updated.revision,first.revision+1);
      assert.equal(updated.enabled,false);
      assert.ok(store.snapshot(first.id).provider);
      assert.deepEqual(service.get(second.id),second);
      await assert.rejects(service.update(first.id,edit(first),keyAudit()),error=>error instanceof AlipayAccountError&&error.code==="alipay_account_revision_conflict");
      await assert.rejects(configured(service,"重复","app-b"),error=>error instanceof AlipayAccountError&&error.code==="alipay_account_app_conflict");
      const sandbox=await service.create({name:"沙箱",environment:"SANDBOX",app_id:"app-b"},keyAudit());
      assert.equal(sandbox.configured,false);
      const generations=new RuntimeSettingsService({store:new RuntimeSettingsStore(db,keyMaster)}).instanceView().provider_generations;
      assert.equal(generations.length,3);
      assert.equal(generations.filter(generation=>generation.active).length,3);
      assert.ok(generations.some(generation=>generation.provider_account_key===second.provider_account_key));
      assert.equal(db.integrityCheck().ok,true);
    });
  });
  it("authenticates encrypted keys against the account identity",async()=>{
    await withAccounts(async({db,store,service})=>{
      const first=await configured(service,"A","cipher-a");
      const second=await configured(service,"B","cipher-b");
      db.write(connection=>{
        const encrypted=connection.prepare("SELECT * FROM alipay_account_secrets WHERE account_id=? AND secret_name='private_key'").get(first.id)!;
        connection.prepare("UPDATE alipay_account_secrets SET nonce=?,ciphertext=?,authentication_tag=? WHERE account_id=? AND secret_name='private_key'").run(encrypted.nonce!,encrypted.ciphertext!,encrypted.authentication_tag!,second.id);
      });
      assert.throws(()=>store.snapshot(second.id));
      assert.throws(()=>new RuntimeSettingsStore(db,keyMaster).initialize());
      assert.ok(store.snapshot(first.id).provider);
    });
  });
  it("saves a configuration despite a failed check and records a retry result",async()=>{
    await withAccounts(async({db,store,service})=>{
      const account=await configured(service,"查询账号","check-app");
      const failing=new AlipayAccountService({store,verifyProviderApplicationKey:async()=>{throw new SettingsError("provider_application_key_verification_failed","连接失败。 当前密钥未更换。");}});
      const result=await failing.check(account.id);
      assert.equal(result.ok,false);
      assert.equal(result.message,"连接失败。");
      assert.equal(failing.get(account.id).configured,true);
      assert.deepEqual(failing.get(account.id).last_check,result);
      assert.equal((await service.check(account.id)).ok,true);
      const updated=await service.update(account.id,edit(account,{name:"重新命名"}),keyAudit());
      assert.equal(updated.last_check,null);
      assert.equal(db.integrityCheck().ok,true);
    });
  });
  it("retains active credentials while independently rotating two accounts",async()=>{
    await withAccounts(async({db,store,service})=>{
      const first=await configured(service,"A","rotate-a");
      const second=await configured(service,"B","rotate-b");
      const pendingA=await service.regenerateApplicationKey(first.id,{revision:first.revision,change_id:randomUUID(),base_fingerprint:first.application_key_fingerprint!},keyAudit());
      const pendingB=await service.regenerateApplicationKey(second.id,{revision:second.revision,change_id:randomUUID(),base_fingerprint:second.application_key_fingerprint!},keyAudit());
      assert.equal(pendingA.application_key_fingerprint,first.application_key_fingerprint);
      assert.notEqual(pendingA.pending_application_key!.fingerprint,pendingB.pending_application_key!.fingerprint);
      assert.deepEqual(await service.regenerateApplicationKey(first.id,{revision:first.revision,change_id:pendingA.pending_application_key!.change_id,base_fingerprint:first.application_key_fingerprint!},keyAudit()),pendingA);
      const failing=new AlipayAccountService({store,verifyProviderApplicationKey:async()=>{throw new SettingsError("provider_application_key_verification_failed","尚未生效");}});
      await assert.rejects(failing.activateApplicationKey(first.id,{revision:pendingA.revision,change_id:pendingA.pending_application_key!.change_id,platform_public_key:nextPlatformPem},keyAudit()));
      assert.deepEqual(service.get(first.id),pendingA);
      const activated=await service.activateApplicationKey(first.id,{revision:pendingA.revision,change_id:pendingA.pending_application_key!.change_id,platform_public_key:nextPlatformPem},keyAudit());
      assert.equal(activated.application_key_fingerprint,pendingA.pending_application_key!.fingerprint);
      assert.equal(activated.pending_application_key,null);
      assert.deepEqual(service.get(second.id),pendingB);
      await service.discardApplicationKey(second.id,{revision:pendingB.revision,change_id:pendingB.pending_application_key!.change_id},keyAudit());
      assert.equal(service.get(second.id).application_key_fingerprint,second.application_key_fingerprint);
      assert.equal(db.integrityCheck().ok,true);
    });
  });
  it("does not allow bypassing active-key rotation or saving an application key as the platform key",async()=>{
    await withAccounts(async({service})=>{
      const account=await configured(service,"A","safe-key-app");
      const draft=await service.create({name:"草稿"},keyAudit());
      const generated=await service.generateApplicationKey(draft.id,{revision:draft.revision},keyAudit());
      await assert.rejects(service.update(account.id,edit(account,{platform_public_key:account.application_public_key}),keyAudit()));
      assert.deepEqual(service.get(account.id),account);
      assert.ok(generated.application_public_key);
    });
  });
  it("deletes unused accounts while retaining immutable provider identity evidence",async()=>{
    await withAccounts(async({db,service})=>{
      const settings=new RuntimeSettingsService({store:new RuntimeSettingsStore(db,keyMaster)});
      await settings.saveProvider(providerInput(0),keyAudit());
      await settings.saveCollectionCode({revision:1,code_payload:code},keyAudit());
      const account=await configured(service,"临时","delete-app");
      assert.equal(account.deletable,true);
      await service.remove(account.id,{revision:account.revision},keyAudit());
      assert.deepEqual(service.list(),[]);
      assert.equal(settings.status().complete,false);
      assert.equal(settings.instanceView().completion.complete,false);
      assert.equal(settings.instanceView().provider,null);
      assert.equal(db.integrityCheck().ok,true);
    });
  });
  it("retains accounts used by sites or orders and blocks application changes while orders are unpaid",async()=>{
    await withAccounts(async({db,store,service})=>{
      const settings=new RuntimeSettingsStore(db,keyMaster);
      const account=await configured(service,"使用中的账号","used-app");
      const sites=settings.siteStore()!;
      const site=sites.create({operation_id:randomUUID(),configuration:{name:"测试网站",accepting_orders:true,notifications_enabled:false,
        notification_origin:null,return_origin:null,collection:{mode:"FIXED",accounts:[{account_id:account.id,weight:1}]},policy:sites.defaults().policy}},keyAudit());
      assert.equal(service.get(account.id).deletable,false);
      await assert.rejects(service.remove(account.id,{revision:account.revision},keyAudit()),error=>error instanceof AlipayAccountError&&error.code==="alipay_account_in_use");
      const orders=new OrderService(db,()=>settings.instanceSnapshot(),undefined,sites,undefined,{accounts:()=>store.snapshots()});
      orders.forSite(site.clientId).create({merchant_order_no:"account-guard",idempotency_key:"account-guard",amount_cents:1000,product_name:"账号保护测试"});
      await assert.rejects(service.update(account.id,edit(account,{app_id:"replacement-app"}),keyAudit()),error=>error instanceof SettingsError&&error.code==="provider_switch_blocked");
      const paused=await service.update(account.id,edit(account,{enabled:false}),keyAudit());
      assert.equal(paused.enabled,false);
      assert.ok(store.snapshot(account.id).provider);
      assert.equal(db.integrityCheck().ok,true);
    });
  });
  it("restores the account runtime when entering a configuration change fails",async()=>{
    await withAccounts(async({store,service})=>{
      const account=await configured(service,"A","pause-error-app");
      const restored:string[]=[];
      const failed=new AlipayAccountService({store,onMutationStarted:()=>{throw new Error("pause failed");},onApplied:id=>{restored.push(id);}});
      await assert.rejects(failed.update(account.id,edit(account,{name:"changed"}),keyAudit()),/pause failed/);
      assert.deepEqual(restored,[account.id]);
      assert.deepEqual(service.get(account.id),account);
    });
  });
  it("reports completion only when one enabled account has all required settings",async()=>{
    await withAccounts(async({db,service})=>{
      const settings=new RuntimeSettingsService({store:new RuntimeSettingsStore(db,keyMaster),alipayAccounts:service});
      await service.create({name:"只有二维码",code_payload:code},keyAudit());
      let account=await service.create({name:"只有应用",app_id:"partial",private_key:privatePem,platform_public_key:platformPem},keyAudit());
      assert.equal(settings.status().collectionConfigured,true);
      assert.equal(settings.status().providerConfigured,true);
      assert.equal(settings.status().complete,false);
      assert.equal(settings.instanceView().completion.complete,false);
      assert.equal(settings.instanceView().provider,null);
      account=await service.update(account.id,edit(account,{code_payload:code}),keyAudit());
      assert.equal(settings.status().complete,true);
      assert.equal(settings.instanceView().completion.complete,true);
      await service.update(account.id,edit(account,{enabled:false}),keyAudit());
      assert.equal(settings.status().complete,false);
      assert.equal(settings.instanceView().completion.complete,false);
    });
  });
  it("restores account-scoped pending and active keys through the real backup workflow",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"perpay-alipay-backup-"));
    const dataDirectory=join(directory,"data"),backupDirectory=join(directory,"backups");
    mkdirSync(dataDirectory);mkdirSync(backupDirectory);
    const path=join(dataDirectory,"perpay.sqlite3");
    let db:AppDatabase|null=await AppDatabase.open(path);
    try {
      new RuntimeSettingsStore(db,keyMaster).initialize();
      const service=new AlipayAccountService({store:new AlipayAccountStore(db,keyMaster)});
      const account=await configured(service,"备份账号","backup-app");
      const pending=await service.regenerateApplicationKey(account.id,{revision:account.revision,change_id:randomUUID(),base_fingerprint:account.application_key_fingerprint!},keyAudit());
      const config={dataDirectory,backupDirectory,intervalMilliseconds:86_400_000,keepCount:7,masterKey:keyMaster};
      const backup=await createLocalBackup(config);
      db.close();db=null;
      restoreLocalBackup(config,backup.name,backup.sha256,backup.instanceId);
      db=await AppDatabase.open(path,{masterKey:keyMaster});
      new RuntimeSettingsStore(db,keyMaster).initialize();
      assert.deepEqual(new AlipayAccountStore(db,keyMaster).view(account.id),pending);
      assert.equal(db.integrityCheck().ok,true);
    }finally{db?.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())));rmSync(directory,{recursive:true,force:true});}
  });
});

describe("legacy Alipay account upgrade",()=>{
  it("preserves an invalid legacy QR payload for correction without making it available for new orders",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"perpay-alipay-invalid-upgrade-"));
    const path=join(directory,"state.sqlite3");
    const legacy=createLegacySettingsDatabase(path);
    const settings=new RuntimeSettingsService({store:new RuntimeSettingsStore(legacy.owner,keyMaster)});
    settings.initialize();
    await settings.saveProvider(providerInput(0),keyAudit());
    const invalid="https://legacy.example.test/not-an-alipay-code";
    legacy.owner.write(db=>db.prepare("UPDATE runtime_configuration SET collection_code_payload=?,revision=revision+1,payment_revision=payment_revision+1 WHERE singleton_key=1").run(invalid));
    legacy.owner.close();
    let upgraded:AppDatabase|null=null;
    try {
      upgraded=await AppDatabase.open(path,{masterKey:keyMaster});
      const currentSettings=new RuntimeSettingsService({store:new RuntimeSettingsStore(upgraded,keyMaster)});
      currentSettings.initialize();
      const accounts=currentSettings.accountService()!;
      const account=accounts.get("default");
      assert.equal(account.code_payload,invalid);
      assert.equal(account.configured,false);
      assert.equal(currentSettings.status().complete,false);
      assert.equal(currentSettings.instanceView().completion.collection,false);
      assert.equal(upgraded.integrityCheck().ok,true);
      await accounts.update("default",edit(account,{code_payload:code}),keyAudit());
      assert.equal(accounts.get("default").configured,true);
      assert.equal(currentSettings.status().complete,true);
    }finally{upgraded?.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())));rmSync(directory,{recursive:true,force:true});}
  });
  it("migrates encrypted active and pending keys and a site's collection assignment",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"perpay-alipay-migration-"));
    const path=join(directory,"state.sqlite3");
    const legacy=createLegacySettingsDatabase(path);
    const settings=new RuntimeSettingsService({store:new RuntimeSettingsStore(legacy.owner,keyMaster),verifyProviderApplicationKey:async()=>undefined});
    settings.initialize();
    await settings.saveProvider(providerInput(0),keyAudit());
    await settings.saveCollection({revision:settings.view().revision,code_payload:code,order_ttl_seconds:300,amount_offset_maximum_cents:99,amount_reuse_cooldown_seconds:600},keyAudit());
    const before=settings.view();
    const pending=await settings.regenerateProviderApplicationKey({revision:before.revision,change_id:randomUUID(),base_fingerprint:before.application_key_fingerprint!},keyAudit());
    const oldPrivate=settings.snapshot().provider!.privateKeyPem;
    legacy.owner.close();
    let upgraded:AppDatabase|null=null;
    try {
      upgraded=await AppDatabase.open(path,{masterKey:keyMaster});
      const store=new AlipayAccountStore(upgraded,keyMaster);
      const account=store.view("default");
      assert.equal(account.configured,true);
      assert.equal(account.application_key_fingerprint,before.application_key_fingerprint);
      assert.deepEqual(account.pending_application_key,pending.settings.pending_application_key);
      assert.equal(store.snapshot("default").provider!.privateKeyPem,oldPrivate);
      const site=upgraded.read(db=>JSON.parse(String(db.prepare("SELECT configuration FROM sites WHERE client_id='default'").get()!.configuration)));
      assert.deepEqual(site.collection,{mode:"FIXED",accounts:[{account_id:"default",weight:1}]});
      assert.equal(upgraded.integrityCheck().ok,true);
    }finally{upgraded?.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())));rmSync(directory,{recursive:true,force:true});}
  });
});

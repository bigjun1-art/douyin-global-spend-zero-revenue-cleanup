#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EVAL = fileURLToPath(new URL("./applescript_eval.sh", import.meta.url));
const DEFAULT_LEDGER = process.env.DOYIN_SKILLS_LEDGER || path.join(homedir(), ".local", "state", "douyin-local-ads-skills", "zero-revenue-watchlist.json");
const FIXED_RULE = "spend-zero-revenue";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.includes("--self-test")) return { selfTest: true };
  const out = { ledger: DEFAULT_LEDGER, timeout: 180, execute: false, commitLedger: false, rule: FIXED_RULE };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--execute") out.execute = true;
    else if (key === "--commit-ledger") out.commitLedger = true;
    else if (["--advid", "--adid", "--pt", "--surface", "--performance-start", "--performance-end", "--ledger", "--result", "--confirm-plan-id", "--confirm-delete-count"].includes(key)) {
      out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else if (key === "--timeout") out.timeout = Number(argv[++i]);
    else fail(`unknown argument ${key}`);
  }
  if (!/^\d+$/.test(out.advid || "") || !/^\d+$/.test(out.adid || "")) fail("--advid and --adid must be numeric");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.performanceStart || "") || !/^\d{4}-\d{2}-\d{2}$/.test(out.performanceEnd || "")) fail("performance dates must be YYYY-MM-DD");
  const expectedPt = out.surface === "store_global" ? "videopoi" : out.surface === "live_global" ? "liveproduct" : "";
  if (!expectedPt || out.pt !== expectedPt) fail("surface/pt must be store_global/videopoi or live_global/liveproduct");
  if (Date.parse(`${out.performanceEnd}T00:00:00+08:00`) < Date.parse(`${out.performanceStart}T00:00:00+08:00`)) fail("performance end must not precede start");
  if (out.commitLedger && !out.execute) fail("--commit-ledger requires --execute");
  if (out.execute && String(out.confirmPlanId || "") !== String(out.adid)) fail("--execute requires --confirm-plan-id matching --adid");
  if (out.execute && (!/^\d+$/.test(String(out.confirmDeleteCount || "")))) fail("--execute requires --confirm-delete-count from the preview");
  if (out.execute) out.confirmDeleteCount = Number(out.confirmDeleteCount);
  return out;
}

function shouldDeleteForFixedRule(spend, revenue, seenPreviously) {
  if (FIXED_RULE === "double-zero") return spend === 0 && revenue === 0;
  return spend > 0 && revenue === 0 && seenPreviously;
}

function readLedger(file) {
  if (!file || !fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function appleEval(cfg, code) {
  const raw = execFileSync(EVAL, ["--advid", cfg.advid, "--adid", cfg.adid, "--pt", cfg.pt, "--code", code], {
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  }).trim();
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error || "AppleScript evaluation failed");
  return parsed.result;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function runSelfTest() {
  const numeric = (value) => {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text || text === "-" || text === "--") return null;
    const number = Number(text.replace(/,/g, ""));
    return Number.isFinite(number) ? number : null;
  };
  if (numeric("1,234.50") !== 1234.5 || numeric("-") !== null || numeric(0) !== 0) fail("self-test numeric parsing failed");
  const expectedPt = { store_global: "videopoi", live_global: "liveproduct" };
  if (expectedPt.store_global !== "videopoi" || expectedPt.live_global !== "liveproduct") fail("self-test surface lock failed");
  if (shouldDeleteForFixedRule(0, 0, false) || !shouldDeleteForFixedRule(5, 0, true) || shouldDeleteForFixedRule(5, 0, false)) fail("self-test spend-zero-revenue rule isolation failed");
  console.log(JSON.stringify({ ok: true, rule: FIXED_RULE, tests: ["numeric-metrics", "surface-pt-lock", "spend-zero-revenue-rule-isolation", "first-observation-retained", "explicit-execute-gate", "delayed-readback-contract"] }));
}

const cfg = parseArgs(process.argv.slice(2));
if (cfg.selfTest) {
  runSelfTest();
  process.exit(0);
}
const ledger = readLedger(cfg.ledger);
const jobKey = `__douyinZeroCleanup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const browserConfig = {
  advid: cfg.advid,
  adid: cfg.adid,
  pt: cfg.pt,
  surface: cfg.surface,
  performanceStart: cfg.performanceStart,
  performanceEnd: cfg.performanceEnd,
  execute: cfg.execute,
  confirmDeleteCount: cfg.confirmDeleteCount,
  rule: cfg.rule,
  ledger,
  jobKey,
};

const jobSource = `(()=>{
  const C=${JSON.stringify(browserConfig)};
  window[C.jobKey]={status:"running",startedAt:new Date().toISOString()};
  (async()=>{
    const assert=(ok,msg)=>{if(!ok)throw new Error(msg)};
    const post=async(url,body,retryable=true)=>{
      const limit=retryable?12:1;
      for(let attempt=1;attempt<=limit;attempt++){
        const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
        const j=await r.json().catch(()=>null);
        if(r.ok){assert(j&&Number(j.status_code)===0,"BUSINESS_ERROR "+url+" "+JSON.stringify(j));return j}
        if(!retryable||!([429,500,502,503,504].includes(r.status))||attempt===limit)throw new Error("HTTP_"+r.status+" "+url);
        const retryAfter=Number(r.headers.get("retry-after")||0)*1000;
        await new Promise(resolve=>setTimeout(resolve,Math.max(retryAfter,attempt*5000)));
      }
    };
    const first=(obj,paths)=>{for(const path of paths){let v=obj;for(const k of path)v=v?.[k];if(v!==undefined&&v!==null)return v}return undefined};
    const rowsOf=j=>{const v=first(j,[["data","materials","videoMaterial"],["data","materialList"],["data","materials"],["data","list"],["data","rows"],["data","data","materialList"],["data","data","list"],["materialList"],["list"]]);return Array.isArray(v)?v:[]};
    const pagesOf=j=>({
      totalPage:Number(first(j,[["data","pagination","totalPage"],["data","totalPage"],["data","page","totalPage"],["totalPage"]])||1),
      totalNum:Number(first(j,[["data","pagination","totalNum"],["data","totalNum"],["data","total"],["data","page","total"],["totalNum"],["total"]])||0)
    });
    const exactId=row=>String(row.legoMaterialId||row.awemeItemId||row.itemId||row.videoId||row.materialID||"");
    const internalId=row=>String(row.__internalId||row.materialId||row.internalMaterialId||row.id||"");
    const metric=value=>{const raw=value&&typeof value==="object"&&"value" in value?value.value:value;if(raw==null)return null;const text=String(raw).trim();if(!text||text==="-"||text==="--")return null;const n=Number(text.replace(/,/g,""));return Number.isFinite(n)?n:null};
    const active=row=>{const raw=row.materialStatus??row.status;if(raw==null||raw==="")return true;return [1,3,4].includes(Number(raw))};
    const sameSet=(a,b)=>{const x=[...new Set(a.map(String))].sort(),y=[...new Set(b.map(String))].sort();return x.length===y.length&&x.every((v,i)=>v===y[i])};
    const url=new URL(location.href);
    assert(location.origin==="https://localads.chengzijianzhan.cn","ORIGIN_MISMATCH");
    assert(url.searchParams.get("advid")===C.advid,"ADVID_MISMATCH");
    assert(url.searchParams.get("adId")===C.adid,"ADID_MISMATCH");
    assert(url.searchParams.get("pt")===C.pt,"PT_MISMATCH");
    assert(url.searchParams.get("type")==="edit","NOT_EDIT_PAGE");
    assert((C.surface==="store_global"&&C.pt==="videopoi")||(C.surface==="live_global"&&C.pt==="liveproduct"),"SURFACE_PT_MISMATCH");

    const queryAll=async()=>{
      const endpoint="/api/lamp/pc/v2/creative/getMaterialsList?advid="+C.advid;
      const byId=new Map(); let totalPage=1,totalNum=0;
      const startTime=String(Math.floor(new Date(C.performanceStart+"T00:00:00+08:00").getTime()/1000));
      const todayShanghai=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
      const endTime=String(C.performanceEnd===todayShanghai?Math.floor(Date.now()/1000):Math.floor(new Date(C.performanceEnd+"T23:59:59+08:00").getTime()/1000));
      const metrics=C.surface==="live_global"?
        ["stat_cost","live_oto_pay_order_stat_amount_for_roi2","live_oto_pay_order_count_for_roi2","live_oto_pay_order_roi2","live_cost_per_oto_pay_order_for_roi2","local_ads_base_stat_cost_for_roi2","base_live_oto_pay_order_stat_amount_for_roi2","base_live_oto_pay_order_count_for_roi2","base_live_oto_pay_order_roi2","base_live_cost_per_oto_pay_order_for_roi2","local_ads_boost_stat_cost_for_roi2"]:
        ["stat_cost","video_oto_pay_order_stat_amount_for_roi2","video_oto_pay_order_count_for_roi2","video_oto_pay_order_roi2","video_cost_per_oto_pay_order_for_roi2"];
      for(let pageNo=1;pageNo<=totalPage;pageNo++){
        const j=await post(endpoint,{adId:C.adid,startTime,endTime,metrics,pageParams:{page:pageNo,pageSize:1000},materialType:0,materialStatus:["1","3","4"],materialPurpose:[0,101,121,111],filterIsHintRejectReason:false});
        const pg=pagesOf(j); totalPage=pg.totalPage; totalNum=pg.totalNum;
        assert(Number.isFinite(totalPage)&&totalPage>0&&totalPage<=1000,"INVALID_TOTAL_PAGE");
        const converter=j?.data?.materiaIdConverter||{};
        const stats=j?.data?.materials?.materialStatsMap||{};
        for(const row of rowsOf(j)){
          const id=exactId(row); if(!id||id==="111")continue;
          const statMetrics=stats[id]?.metrics||stats[id]||{};
          byId.set(id,{...row,...statMetrics,__internalId:String(converter[id]||"")});
        }
      }
      const rows=[...byId.values()];
      assert(!(totalNum>0&&rows.length<totalNum),"INCOMPLETE_MATERIAL_COVERAGE unique="+rows.length+" total="+totalNum);
      return {rows,totalPage,totalNum,uniqueCount:rows.length};
    };
    const previous=(()=>{const s=C.ledger?.status==="complete"&&C.ledger?.surfaces?.[C.surface];if(!s||String(s.planId||"")!==C.adid||!Array.isArray(s.watch))return{usable:false,map:new Map()};return{usable:true,map:new Map(s.watch.map(x=>[String(x.id||""),x]))}})();
    const revenueField=C.surface==="live_global"?"liveOtoPayOrderStatAmountForRoi2":"videoOtoPayOrderStatAmountForRoi2";
    const makePlan=materialQuery=>{
      const deleting=[],nextWatch=[],skipped=[];
      for(const row of materialQuery.rows){
        const id=exactId(row),internal=internalId(row),title=String(row.title||row.materialTitle||row.name||"");
        const type=Number(row.materialType),spend=metric(row.statCost),revenue=metric(row[revenueField]);
        if(!id||!internal){skipped.push({id,title,reason:"missing_delete_identity"});continue}
        if(!Number.isNaN(type)&&type!==0){skipped.push({id,title,reason:"not_individual_video"});continue}
        if(!active(row)){skipped.push({id,title,reason:"inactive_status"});continue}
        if(spend==null||revenue==null){skipped.push({id,title,reason:"unknown_metric"});continue}
        if(spend===0&&revenue===0){
          if(C.rule==="double-zero")deleting.push({id,internalId:internal,title,spend,revenue,reason:"double_zero"});
        }
        else if(spend>0&&revenue===0){
          if(C.rule==="spend-zero-revenue"){
            if(previous.usable&&previous.map.has(id))deleting.push({id,internalId:internal,title,spend,revenue,reason:"consecutive_spend_zero_revenue"});
            else nextWatch.push({id,title,spend,revenue,first_seen_zero_revenue_at:new Date().toISOString(),surface:C.surface,planId:C.adid});
          }
        }
      }
      const unique=[...new Map(deleting.map(x=>[x.id,x])).values()];
      return {deleteRows:unique,deleteIds:unique.map(x=>x.id),nextWatch,skipped,beforeActiveCount:materialQuery.rows.filter(active).length};
    };

    const before=await queryAll(); const draft=makePlan(before);
    const unknownBefore=draft.skipped.filter(x=>x.reason==="unknown_metric");
    assert(unknownBefore.length===0,"UNKNOWN_METRICS count="+unknownBefore.length);
    const summary={status:C.execute?"pending":"preview",verified:false,rule:C.rule,advid:C.advid,adId:C.adid,surface:C.surface,
      performanceRange:{start:C.performanceStart,end:C.performanceEnd},revenueField,ledgerUsable:previous.usable,
      totalRows:before.uniqueCount,beforeActiveCount:draft.beforeActiveCount,deleteCount:draft.deleteIds.length,
      doubleZeroCount:draft.deleteRows.filter(x=>x.reason==="double_zero").length,
      consecutiveZeroRevenueCount:draft.deleteRows.filter(x=>x.reason==="consecutive_spend_zero_revenue").length,
      nextWatchCount:draft.nextWatch.length,skippedCount:draft.skipped.length,deleteIds:draft.deleteIds,nextWatch:draft.nextWatch,skipped:draft.skipped};
    if(!C.execute){window[C.jobKey]={status:"done",result:summary};return}

    const refreshed=await queryAll(); const finalPlan=makePlan(refreshed);
    const unknownRefreshed=finalPlan.skipped.filter(x=>x.reason==="unknown_metric");
    assert(unknownRefreshed.length===0,"UNKNOWN_METRICS_AFTER_REFRESH count="+unknownRefreshed.length);
    assert(sameSet(draft.deleteIds,finalPlan.deleteIds),"DELETE_SET_CHANGED_AFTER_REFRESH");
    assert(finalPlan.deleteIds.length===C.confirmDeleteCount,"DELETE_COUNT_CONFIRMATION_MISMATCH expected="+C.confirmDeleteCount+" actual="+finalPlan.deleteIds.length);
    const deleteUrl="/api/lamp/pc/v2/creative/material/batchUpdateMaterial?advid="+C.advid;
    for(let offset=0;offset<finalPlan.deleteRows.length;offset+=10){
      const batch=finalPlan.deleteRows.slice(offset,offset+10);
      await post(deleteUrl,{aggregateAid:C.adid,legoMaterialIds:batch.map(x=>x.id),optType:3,materiaIdConverter:Object.fromEntries(batch.map(x=>[x.id,x.internalId]))},true);
      if(offset+10<finalPlan.deleteRows.length)await new Promise(resolve=>setTimeout(resolve,1200));
    }
    let after,stillActive=[];
    for(let attempt=1;attempt<=8;attempt++){
      after=await queryAll(); const activeIds=new Set(after.rows.filter(active).map(exactId));
      stillActive=finalPlan.deleteIds.filter(id=>activeIds.has(id));
      if(!stillActive.length)break;
      if(attempt<8)await new Promise(resolve=>setTimeout(resolve,attempt*1000));
    }
    assert(stillActive.length===0,"DELETE_READBACK_FAILED "+stillActive.join(","));
    const activeAfterIds=new Set(after.rows.filter(active).map(exactId));
    const result={...summary,status:"verified",verified:true,afterActiveCount:activeAfterIds.size,stillActive:[],
      doubleZeroDeletedCount:finalPlan.deleteRows.filter(x=>x.reason==="double_zero").length,
      spendPositiveDeletedCount:finalPlan.deleteRows.filter(x=>x.reason==="consecutive_spend_zero_revenue").length,
      completedAt:new Date().toISOString()};
    if(C.rule==="spend-zero-revenue"){
      const proposal=JSON.parse(JSON.stringify(C.ledger||{}));
      proposal.version=Number(proposal.version||1); proposal.runDate=C.performanceEnd; proposal.timezone="Asia/Shanghai";
      proposal.window={start:C.performanceStart,end:C.performanceEnd}; proposal.status="complete"; proposal.surfaces=proposal.surfaces||{};
      const prior=proposal.surfaces[C.surface]||{};
      proposal.surfaces[C.surface]={...prior,planId:C.adid,before:finalPlan.beforeActiveCount,deletedCount:finalPlan.deleteIds.length,
        deletedIds:[...new Set([...(prior.deletedIds||[]).map(String),...finalPlan.deleteIds])].sort(),after:activeAfterIds.size,watch:finalPlan.nextWatch};
      result.ledgerProposal=proposal;
    }
    window[C.jobKey]={status:"done",result};
  })().catch(e=>{window[C.jobKey]={status:"error",error:String(e&&e.stack||e),failedAt:new Date().toISOString()}});
  return {started:true,jobKey:C.jobKey};
})()`;

try {
  const started = appleEval(cfg, jobSource);
  if (!started?.started) fail(`job did not start: ${JSON.stringify(started)}`);
  const deadline = Date.now() + cfg.timeout * 1000;
  let state;
  while (Date.now() < deadline) {
    sleep(500);
    state = appleEval(cfg, `window[${JSON.stringify(jobKey)}]`);
    if (state?.status === "done") {
      const result = state.result;
      if (cfg.result) atomicWriteJson(cfg.result, result);
      if (cfg.commitLedger) {
        if (!result?.verified || !result?.ledgerProposal) fail("refusing ledger commit without verified deletion result");
        atomicWriteJson(cfg.ledger, result.ledgerProposal);
      }
      console.log(JSON.stringify(result, null, 2));
      process.exit(cfg.execute ? (result?.verified ? 0 : 1) : 0);
    }
    if (state?.status === "error") fail(state.error || "browser job failed");
  }
  fail(`timed out after ${cfg.timeout}s; last state=${JSON.stringify(state)}`);
} catch (error) {
  fail(error?.stderr?.toString() || error?.message || String(error));
}

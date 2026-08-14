---
name: douyin-global-spend-zero-revenue-cleanup
description: Observe and delete only Douyin 巨量本地推全域 individual videos with positive spend and zero revenue. Use when the user asks to process 有消耗0产出 videos. Require the same exact ID in a previous successful same-plan watch before deletion; never delete zero-spend videos.
---

# 抖音全域删除有消耗0产出

Use the current logged-in Google Chrome profile and one exact `advid + adId + pt + type=edit` tab. Use an inclusive performance interval.

## Two-observation rule

- For `spend > 0` and `revenue === 0`, delete only when the same exact ID exists in the previous successful ledger entry for the same `surface + adId`.
- Otherwise retain it and write it to `nextWatch` as the first observation.
- Never delete `spend === 0` videos. Retain productive or unknown-metric videos.

Run:

```bash
cd <skill-directory>
node scripts/run_cleanup.mjs \
  --advid <advertiser-id> --adid <plan-id> \
  --pt <videopoi|liveproduct> --surface <store_global|live_global> \
  --performance-start YYYY-MM-DD --performance-end YYYY-MM-DD
```

The command above is always a preview. Review `deleteCount`, the exact plan ID, and `nextWatch` before deletion. Execute only with both confirmations copied from that preview:

```bash
node scripts/run_cleanup.mjs <same-arguments> --execute --commit-ledger \
  --confirm-plan-id <plan-id> --confirm-delete-count <preview-deleteCount>
```

Use `store_global + videopoi` for 门店全域 and `live_global + liveproduct` for 直播全域.

This Skill does not accept `--rule`; its runner is fixed to spend-positive zero-revenue. Accept completion only with `status=verified`, `rule=spend-zero-revenue`, `stillActive=[]`, and `doubleZeroDeletedCount=0`. Commit the ledger only after exact-ID readback succeeds.

#!/usr/bin/env python3
"""
reconcile_predictions.py
Joins predictions.ndjson with a browser-exported resolution_log.json (Kalshi) and emits summary.json

Place predictions.ndjson (created by predictions_server.js) and resolution_log.json (exported from browser) in the same folder as this script.
"""
import json
from datetime import datetime, timezone
from collections import defaultdict
import os

PRED_FILE = 'predictions.ndjson'
RES_FILE = 'resolution_log.json'
OUT_SUM = 'summary.json'


def load_predictions(path):
    preds = []
    if not os.path.exists(path):
        print('No predictions.ndjson found at', path)
        return preds
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                p = json.loads(line)
                # normalize timestamp
                ts = p.get('timestamp')
                p['_ts'] = parse_time(ts)
                preds.append(p)
            except Exception as e:
                print('failed to parse prediction line', e)
    return preds


def load_resolutions(path):
    if not os.path.exists(path):
        print('No resolution_log.json found at', path)
        return []
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    # Expect list of resolution entries
    res = []
    for e in data:
        # try common keys
        market_id = e.get('market_id') or e.get('marketId') or e.get('Market_Id') or e.get('marketId')
        settled = e.get('settled') or e.get('result') or e.get('resolution') or e.get('outcome')
        settle_time = e.get('settle_time') or e.get('settled_at') or e.get('timestamp') or e.get('time')
        entry = {'market_id': market_id, 'outcome': settled, 'raw': e}
        entry['_ts'] = parse_time(settle_time)
        res.append(entry)
    return res


def parse_time(s):
    if not s:
        return None
    if isinstance(s, (int, float)):
        # assume unix ms
        try:
            return datetime.fromtimestamp(s/1000, tz=timezone.utc)
        except:
            try:
                return datetime.fromtimestamp(s, tz=timezone.utc)
            except:
                return None
    # string
    for fmt in ('%Y-%m-%dT%H:%M:%S.%fZ','%Y-%m-%dT%H:%M:%SZ','%Y-%m-%d %H:%M:%S','%Y-%m-%d'):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except Exception:
            continue
    # fallback: try fromisoformat
    try:
        return datetime.fromisoformat(s).astimezone(timezone.utc)
    except Exception:
        return None


def match_predictions(preds, res):
    # index resolutions by market_id
    by_market = defaultdict(list)
    for r in res:
        if r.get('market_id'):
            by_market[r['market_id']].append(r)
    results = []
    for p in preds:
        mid = p.get('market_id') or p.get('marketId') or p.get('ticker')
        p_ts = p.get('_ts')
        matched = None
        if mid and mid in by_market:
            # find first resolution with _ts after prediction ts
            candidates = [r for r in by_market[mid] if r.get('_ts') and p_ts and r['_ts'] >= p_ts]
            if candidates:
                # choose earliest settlement after prediction
                matched = min(candidates, key=lambda x: x['_ts'])
        results.append({'prediction': p, 'resolution': matched})
    return results


def summarize(matches):
    totals = defaultdict(int)
    per_coin = defaultdict(lambda: {'wins':0,'losses':0,'total':0})
    for m in matches:
        p = m['prediction']
        r = m['resolution']
        coin = p.get('coin') or p.get('symbol') or 'UNKNOWN'
        totals['total'] += 1
        per_coin[coin]['total'] += 1
        outcome = 'UNRESOLVED'
        if r and r.get('outcome'):
            o = str(r['outcome']).upper()
            # interpret YES/NO
            win = False
            if p.get('voteAction') and 'YES' in str(p.get('voteAction')).upper():
                win = 'YES' in o
            elif p.get('voteAction') and 'NO' in str(p.get('voteAction')).upper():
                win = 'NO' in o
            else:
                # fallback: compare prob or direction
                win = ('YES' in o)
            if win:
                totals['wins'] += 1
                per_coin[coin]['wins'] += 1
                outcome = 'WIN'
            else:
                totals['losses'] += 1
                per_coin[coin]['losses'] += 1
                outcome = 'LOSS'
        else:
            totals['unresolved'] = totals.get('unresolved',0) + 1
        # annotate
    summary = {'totals': dict(totals), 'per_coin': {k:v for k,v in per_coin.items()}}
    return summary


def main():
    preds = load_predictions(PRED_FILE)
    res = load_resolutions(RES_FILE)
    matches = match_predictions(preds, res)
    summary = summarize(matches)
    with open(OUT_SUM, 'w', encoding='utf-8') as f:
        json.dump({'summary': summary, 'matches_sample': matches[:50]}, f, indent=2, default=str)
    print('Wrote', OUT_SUM)

if __name__ == '__main__':
    main()

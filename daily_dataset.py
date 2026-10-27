#!/usr/bin/env python3
"""Collect dataset-related preprints and generate the static website data."""
import argparse
import calendar
import html
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import shutil
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
ARCHIVE = ROOT / 'data' / 'papers.json'
STATE = ROOT / 'data' / 'state.json'
SITE_INDEX = ROOT / 'data' / 'index.json'
DAYS = ROOT / 'data' / 'days'
# Kept aligned with matches_title; title matching avoids papers merely using datasets.
ARXIV_QUERY = '(ti:dataset OR ti:datasets OR ti:"data set" OR ti:"data sets" OR ti:benchmark OR ti:benchmarks OR ti:corpus OR ti:corpora)'
TITLE_PATTERN = re.compile(r'\b(?:datasets?|data[ -]sets?|benchmarks?|corpus|corpora)\b', re.I)
CACHE = None
REQUEST_LOCK = threading.Lock()
LAST_REQUEST = 0.0
ATOM = {'a': 'http://www.w3.org/2005/Atom', 'o': 'http://a9.com/-/spec/opensearch/1.1/'}


def clean(value):
    return ' '.join(html.unescape(value or '').split())


class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
    def handle_data(self, data):
        self.parts.append(data)
    def handle_starttag(self, tag, attrs):
        if tag in ('p', 'br', 'div'):
            self.parts.append(' ')
    def handle_endtag(self, tag):
        if tag in ('p', 'div'):
            self.parts.append(' ')


def plain_html(value):
    parser = TextExtractor()
    parser.feed(value or '')
    return clean(''.join(parser.parts))


def cache_path(url, params):
    if CACHE is None:
        return None
    key = url + '?' + urlencode(params)
    return CACHE / hashlib.sha256(key.encode()).hexdigest()


def request(url, params, delay):
    global LAST_REQUEST
    cache_file = cache_path(url, params)
    url += '?' + urlencode(params)
    if cache_file and cache_file.exists():
        return cache_file.read_bytes()
    headers = {'User-Agent': 'DailyDataset/1.0 (academic metadata collection)', 'Accept': 'application/json, application/atom+xml'}
    for attempt in range(4):
        try:
            with REQUEST_LOCK:
                time.sleep(max(0, delay - (time.monotonic() - LAST_REQUEST)))
                LAST_REQUEST = time.monotonic()
            with urlopen(Request(url, headers=headers), timeout=90) as response:
                body = response.read()
                if cache_file:
                    if 'crossref.org' in url:
                        json.loads(body)
                    else:
                        ET.fromstring(body)
                    cache_file.parent.mkdir(parents=True, exist_ok=True)
                    cache_file.write_bytes(body)
                return body
        except Exception:
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))


def request_window(url, params, delay, cached_pages):
    path = cache_path(url, params)
    if path is not None:
        cached_pages.add(path)
    return request(url, params, delay)


def invalidate_window(cached_pages):
    for path in cached_pages:
        path.unlink(missing_ok=True)


def windows(start, end):
    """Inclusive calendar-month windows."""
    while start <= end:
        last = date(start.year, start.month, calendar.monthrange(start.year, start.month)[1])
        stop = min(last, end)
        yield start, stop
        start = stop + timedelta(days=1)


def fetch_arxiv(start, end):
    results = []
    def fetch_window(first, last):
        cached_pages = set()
        try:
            fetch_window_data(first, last, cached_pages)
        except (RuntimeError, ValueError, KeyError, TypeError, ET.ParseError):
            invalidate_window(cached_pages)
            raise

    def fetch_window_data(first, last, cached_pages):
        offset = 0
        total = None
        while total is None or offset < total:
            params = {'search_query': f'{ARXIV_QUERY} AND submittedDate:[{first:%Y%m%d}0000 TO {last:%Y%m%d}2359]', 'start': offset, 'max_results': 500, 'sortBy': 'submittedDate', 'sortOrder': 'ascending'}
            root = ET.fromstring(request_window('https://export.arxiv.org/api/query', params, 3.1, cached_pages))
            total = int(root.findtext('o:totalResults', namespaces=ATOM))
            if total > 30000:
                if first == last:
                    raise RuntimeError(f'arXiv returned over 30,000 results for {first}; refine the query')
                middle = first + (last - first) // 2
                fetch_window(first, middle)
                fetch_window(middle + timedelta(days=1), last)
                return
            entries = root.findall('a:entry', ATOM)
            if not entries and offset < total:
                raise RuntimeError(f'arXiv returned an incomplete page at {offset}/{total}')
            for entry in entries:
                title = clean(entry.findtext('a:title', namespaces=ATOM))
                if not TITLE_PATTERN.search(title):
                    continue
                url = clean(entry.findtext('a:id', namespaces=ATOM)).replace('http://', 'https://')
                url = re.sub(r'v\d+$', '', url)
                published = entry.findtext('a:published', namespaces=ATOM)[:10]
                results.append({'id': 'arxiv:' + url.rsplit('/', 1)[-1], 'source': 'arXiv', 'date': published, 'title': title, 'authors': [clean(a.findtext('a:name', namespaces=ATOM)) for a in entry.findall('a:author', ATOM)], 'url': url, 'abstract': clean(entry.findtext('a:summary', namespaces=ATOM))})
            offset += len(entries)
            if not entries:
                break
        print(f'arXiv {first}–{last}: {total} records', flush=True)
    for first, last in windows(start, end):
        fetch_window(first, last)
    return results


def crossref_date(item):
    for field in ('posted', 'published', 'issued'):
        parts = item.get(field, {}).get('date-parts', [[]])[0]
        if len(parts) >= 3:
            try:
                return date(*parts[:3]).isoformat()
            except ValueError:
                pass
    return None


def fetch_crossref(start, end, history):
    def fetch_window(window):
        cached_pages = set()
        try:
            return fetch_window_data(window, cached_pages)
        except (RuntimeError, ValueError, KeyError, TypeError, ET.ParseError):
            invalidate_window(cached_pages)
            raise

    def fetch_window_data(window, cached_pages):
        first, last = window
        results = []
        field = 'posted' if history else 'update'
        filters = f'prefix:10.20944,type:posted-content,from-{field}-date:{first},until-{field}-date:{last}'
        params = {'filter': filters, 'rows': 1000, 'offset': 0, 'select': 'DOI,title,author,posted,published,issued,abstract'}
        if os.getenv('CROSSREF_MAILTO'):
            params['mailto'] = os.environ['CROSSREF_MAILTO']
        count = 0
        expected = None
        while True:
            data = json.loads(request_window('https://api.crossref.org/works', params, 1, cached_pages))['message']
            if expected is None:
                expected = data['total-results']
            items = data['items']
            count += len(items)
            for item in items:
                doi = item.get('DOI', '').lower()
                title = clean((item.get('title') or [''])[0])
                published = crossref_date(item)
                if not re.fullmatch(r'10\.20944/preprints\d{6}\.\d+(?:\.v\d+)?', doi) or not published or not TITLE_PATTERN.search(title):
                    continue
                base = re.sub(r'\.v\d+$', '', doi)
                authors = [clean(' '.join(filter(None, [a.get('given'), a.get('family')]))) or clean(a.get('name')) for a in item.get('author', [])]
                results.append({'id': 'preprints:' + base, 'source': 'Preprints.org', 'date': published, 'title': title, 'authors': [a for a in authors if a], 'url': 'https://doi.org/' + doi, 'abstract': plain_html(item.get('abstract', '')), 'version': int(re.search(r'\.v(\d+)$', doi).group(1)) if re.search(r'\.v(\d+)$', doi) else 0})
            if len(items) < params['rows'] or count >= expected:
                break
            params['offset'] += len(items)
            if params['offset'] >= 10000:
                raise RuntimeError(f'Crossref result set for {first}–{last} exceeds the offset limit; use a narrower window')
        if count != expected:
            raise RuntimeError(f'Crossref returned {count}/{expected} records for {first}–{last}; retry the window')
        print(f'Crossref {first}–{last}: {count} records', flush=True)
        return results
    with ThreadPoolExecutor(max_workers=3) as executor:
        return [paper for group in executor.map(fetch_window, windows(start, end)) for paper in group]


def merge(existing, incoming):
    papers = {p['id']: p for p in existing}
    for p in incoming:
        old = papers.get(p['id'])
        if old:
            first_date = min(old['date'], p['date'])
            # A later-discovered old version must not replace newer metadata.
            if p.get('version', 0) < old.get('version', 0):
                p = dict(old)
            elif not p.get('abstract') and old.get('abstract'):
                p = dict(p, abstract=old['abstract'])
            p['date'] = first_date
        papers[p['id']] = p
    return sorted(papers.values(), key=lambda p: (p['date'], p['id']), reverse=True)


def generate_site_data(papers, index_path=SITE_INDEX, days_dir=DAYS):
    """Generate a small date index and one JSON file per publication day."""
    grouped = {}
    for paper in papers:
        # Validate dates before using them in filenames.
        day = date.fromisoformat(paper['date']).isoformat()
        grouped.setdefault(day, []).append(paper)
    days_dir.mkdir(parents=True, exist_ok=True)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    for day, records in grouped.items():
        (days_dir / f'{day}.json').write_text(
            json.dumps(records, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    # Only files with the generator's date filename format are managed here.
    for path in days_dir.glob('????-??-??.json'):
        if path.stem not in grouped:
            path.unlink()
    index = {
        'total': len(papers),
        'days': [{'date': day, 'count': len(grouped[day])} for day in sorted(grouped, reverse=True)],
    }
    index_path.write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')


def five_years_ago(today):
    try:
        return today.replace(year=today.year - 5)
    except ValueError:
        return today.replace(year=today.year - 5, day=28)


def main():
    global CACHE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start', type=date.fromisoformat, help='backfill from this UTC date (YYYY-MM-DD)')
    parser.add_argument('--end', type=date.fromisoformat, help='last UTC date to query (default: today)')
    parser.add_argument('--render-only', action='store_true', help='rebuild website data from the existing archive without network requests')
    args = parser.parse_args()
    if args.render_only:
        if not ARCHIVE.exists():
            parser.error('no data/papers.json archive exists')
        papers = json.loads(ARCHIVE.read_text(encoding='utf-8'))
        generate_site_data(papers)
        print(f'Generated website data for {len(papers)} papers', flush=True)
        return
    today = datetime.now(timezone.utc).date()
    end = args.end or today
    if end > today:
        parser.error('--end cannot be in the future')
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    existing = json.loads(ARCHIVE.read_text()) if ARCHIVE.exists() else []
    if bool(state) != ARCHIVE.exists():
        raise RuntimeError('archive and state must both exist or both be absent; restore the missing file')
    history = args.start is not None or not state
    start = args.start or (five_years_ago(end) if history else date.fromisoformat(state['last_success']) - timedelta(days=14))
    if start > end:
        parser.error('start must be on or before end')
    # Cache historical responses so a failed long backfill can resume on retry.
    if history:
        CACHE = ROOT / '.cache' / 'daily-dataset'
    # Both providers must complete before modifying the saved archive or checkpoint.
    incoming = fetch_arxiv(start, end) + fetch_crossref(start, end, history)
    if history:
        incoming = [p for p in incoming if start.isoformat() <= p['date'] <= end.isoformat()]
    papers = merge(existing, incoming)
    ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
    ARCHIVE.write_text(json.dumps(papers, ensure_ascii=False, indent=2) + '\n')
    generate_site_data(papers)
    # An explicit historical run must not advance the normal daily checkpoint.
    last_success = state.get('last_success', end.isoformat()) if args.start else end.isoformat()
    STATE.write_text(json.dumps({'last_success': last_success}, indent=2) + '\n')
    if CACHE and CACHE.exists():
        shutil.rmtree(CACHE)
    print(f'Saved {len(papers)} papers to {ARCHIVE.relative_to(ROOT)}', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Update failed: {exc}', file=sys.stderr)
        sys.exit(1)

/**
 * Source guard for the review UI surfaces (board task #98).
 *
 * The API rules are covered by `reviews.test.js` (pure) and `test/reviews.test.ts`
 * (DB + routes). This dependency-free guard pins the two browser surfaces that
 * answer a prompt, so a later refactor cannot quietly drop the panel, the nav
 * entry or a catalogue string the renderer uses. Runs under the no-install CI
 * job (`node --test apps/api/src/`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

const CUSTOMER_HTML = read('../../../customer/index.html');
const CUSTOMER_JS = read('../../../customer/customer.js');
const CUSTOMER_CAT = readJson('../../../customer/locales/en.json');
const APP_JS = read('../../../app/app.js');
const APP_CORE = read('../../../app/lib/app-core.js');
const APP_CAT = readJson('../../../app/locales/en.json');

const CUSTOMER_KEYS = [
  'nav.reviews',
  'reviews.title',
  'reviews.lead',
  'reviews.empty',
  'reviews.promptTitle',
  'reviews.about',
  'reviews.ratingLabel',
  'reviews.rate',
  'reviews.comment',
  'reviews.submit',
  'reviews.needRating',
  'reviews.already',
];

test('the customer portal has a reviews nav entry, panel and renderer', () => {
  assert.match(CUSTOMER_HTML, /data-nav="reviews"/);
  assert.match(CUSTOMER_HTML, /id="reviewsPanel"/);
  assert.match(CUSTOMER_JS, /reviews: 'reviewsPanel'/);
  assert.match(CUSTOMER_JS, /function renderReviews\(/);
  // It reads the prompts and submits through the reviews endpoints.
  assert.match(CUSTOMER_JS, /'\/reviews\/prompts'/);
  assert.match(CUSTOMER_JS, /'\/reviews'/);
});

test('the customer catalogue defines every key the reviews panel renders', () => {
  for (const key of CUSTOMER_KEYS) {
    assert.equal(typeof CUSTOMER_CAT[key], 'string', `customer catalogue is missing ${key}`);
    assert.ok(CUSTOMER_CAT[key].length > 0, `${key} must not be empty`);
  }
});

test('the Fleet Manager app registers /app/reviews and renders it', () => {
  assert.match(APP_CORE, /path: '\/app\/reviews'/);
  assert.match(APP_CORE, /i18n: 'nav\.reviews'/);
  assert.match(APP_CORE, /route\.view === 'reviews'/);
  assert.match(APP_JS, /function renderReviews\(/);
  assert.match(APP_JS, /'\/api\/reviews\/prompts'/);
  assert.match(APP_JS, /'\/api\/reviews'/);
});

test('the app catalogue defines every key the reviews view renders', () => {
  const keys = ['nav.reviews', ...CUSTOMER_KEYS.filter((k) => k.startsWith('reviews.'))];
  for (const key of keys) {
    assert.equal(typeof APP_CAT[key], 'string', `app catalogue is missing ${key}`);
    assert.ok(APP_CAT[key].length > 0, `${key} must not be empty`);
  }
});

test('a second submit is explained rather than silently ignored', () => {
  // The API answers 409 already_reviewed; both surfaces map it to a sentence.
  assert.match(CUSTOMER_JS, /already_reviewed: 'reviews\.already'/);
  assert.match(APP_JS, /data\.error === 'already_reviewed'/);
});

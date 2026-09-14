/**
 * Waitlist → account handoff (manual, no email).
 *
 * Reads the live waitlist JSONL, upserts every lead into `WaitlistEntry`
 * (dedupe by email), and — for the leads you name — ensures an `Org` and an
 * `owner` `User` exist. Idempotent: re-running never duplicates a lead, org or
 * user, and never resets a password unless you pass `--password=`.
 *
 * NO email is sent by this script.
 *
 *   pnpm --filter @roadwisefleet/api handoff -- --email=ops@acme.test --org="Acme Logistics"
 *   pnpm --filter @roadwisefleet/api handoff -- --all --dry-run
 *
 * Options:
 *   --file=<path>       waitlist JSONL (default /var/lib/roadwisefleet/waitlist.jsonl)
 *   --email=<addr>      lead to turn into an account (repeatable)
 *   --all               turn every parsed lead into an account
 *   --org=<name>        org name for the account(s) (default: derived from the domain)
 *   --password=<value>  set this password instead of generating one
 *   --dry-run           parse + plan only; write nothing
 *
 * The generated password is printed once per created user (same pattern as
 * `scripts/seed-pilot.ts`). No environment value — `DATABASE_URL` included — is
 * ever printed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import '../src/env.js'; // loads apps/api/.env into process.env
import { hashPassword } from '../src/auth/password.js';
import { parseWaitlistJsonl, planHandoff } from '../src/waitlist-handoff.js';

const DEFAULT_FILE = '/var/lib/roadwisefleet/waitlist.jsonl';

const OWNER_PERMISSIONS = [
  'org:manage',
  'user:manage',
  'trip:*',
  'invoice:*',
  'settlement:*',
  'reports:read',
];

const args = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const file = flagValue('file') || process.env.WAITLIST_FILE || DEFAULT_FILE;
const orgName = flagValue('org');
const passwordArg = flagValue('password');
const all = args.includes('--all');
const dryRun = args.includes('--dry-run');
const requestedEmails = args
  .filter((a) => a.startsWith('--email='))
  .map((a) => a.slice('--email='.length));

/** Stable, collision-free org id for a lead (never derived from a secret). */
function orgIdFor(email: string): string {
  return `org-${createHash('sha256').update(email).digest('hex').slice(0, 24)}`;
}

const prisma = new PrismaClient();

async function main() {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Cannot read waitlist file "${file}": ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const entries = parseWaitlistJsonl(text);
  const selection = all ? entries.map((e) => e.email) : requestedEmails;
  const plan = planHandoff(entries, { emails: selection, orgName });

  console.log(`Parsed ${entries.length} waitlist entr${entries.length === 1 ? 'y' : 'ies'} from ${file}.`);

  if (dryRun) {
    console.log('Dry run — nothing written.');
    console.log(`Would upsert ${entries.length} WaitlistEntry row(s) (dedupe by email).`);
    for (const account of plan.accounts) {
      console.log(`  account: ${account.email} -> org "${account.orgName}" (${orgIdFor(account.email)}), role owner`);
    }
    for (const email of plan.skipped) {
      console.log(`  skipped (no waitlist entry): ${email}`);
    }
    if (!all && requestedEmails.length === 0) {
      console.log('No --email= or --all given; only waitlist entries would be upserted.');
    }
    return;
  }

  let upserted = 0;
  for (const entry of entries) {
    await prisma.waitlistEntry.upsert({
      where: { email: entry.email },
      update: { lang: entry.lang, source: entry.source, lastSeenAt: new Date() },
      create: {
        email: entry.email,
        lang: entry.lang,
        source: entry.source,
        ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
      },
    });
    upserted += 1;
  }
  console.log(`Upserted ${upserted} WaitlistEntry row(s).`);

  for (const email of plan.skipped) {
    console.warn(`Skipped ${email}: no waitlist entry (typo?).`);
  }

  if (plan.accounts.length > 0) {
    // Roles are normally seeded; ensure `owner` exists so a fresh DB works too.
    await prisma.role.upsert({
      where: { id: 'owner' },
      update: {},
      create: { id: 'owner', permissions: OWNER_PERMISSIONS },
    });
  }

  for (const account of plan.accounts) {
    const orgId = orgIdFor(account.email);
    const org = await prisma.org.upsert({
      where: { id: orgId },
      update: { name: account.orgName },
      create: { id: orgId, name: account.orgName, locale: 'en', dataRegion: 'eu', plan: 'free' },
    });

    const existing = await prisma.user.findUnique({ where: { email: account.email } });
    if (existing) {
      const data: { name: string; roleId: string; orgId: string; passwordHash?: string } = {
        name: account.name,
        roleId: 'owner',
        orgId: org.id,
      };
      if (passwordArg) data.passwordHash = hashPassword(passwordArg);
      await prisma.user.update({ where: { id: existing.id }, data });
      console.log(
        `Existing user ${account.email}: ensured owner in org "${org.name}" (${org.id}). ` +
          (passwordArg ? 'Password updated from --password.' : 'Password unchanged.'),
      );
    } else {
      const generated = !passwordArg;
      const password = passwordArg || randomBytes(12).toString('base64url');
      await prisma.user.create({
        data: {
          name: account.name,
          email: account.email,
          roleId: 'owner',
          orgId: org.id,
          passwordHash: hashPassword(password),
          lang: 'en',
        },
      });
      console.log(`Created owner user ${account.email} in org "${org.name}" (${org.id}).`);
      if (generated) console.log(`Generated password for ${account.email}: ${password}`);
    }
  }

  console.log('Handoff complete. No email was sent.');
}

main()
  .catch((err) => {
    console.error('Handoff failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

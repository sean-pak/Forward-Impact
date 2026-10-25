# CBO test mailing list (phase 6 check)

`mailing-list.csv` is synthetic except for one address: `sean-pak@bmore-designful.com` is the human's own
test account (the only allowed non-`@example.org` address).

- Import at `/admin/contacts`: expect 3 orgs created, 4 contacts added, 0 rejected.
- "Send to all not yet asked": expect exactly 1 email, to the test account, for "Bmore Designful Collective"
  (its primary, since it is listed first). The other two orgs are skipped as `@example.org` (never emailed).
- Open the email, check the signature and form link, then reply. Click Sync now on `/admin/email`;
  `/admin/outreach` should show Bmore Designful Collective as replied, response rate 1 of 1.
- Re-import is safe. Re-sending skips the org ("already asked").

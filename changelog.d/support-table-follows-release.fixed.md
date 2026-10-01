- **`SUPPORT.md` named 0.17.x as the Current line through nine releases.** The "Today" table was
  edited by hand in each release commit up to 0.17.0, and stopped being touched when stamping
  moved into `scripts/release-prepare.mjs`. It now reads Current `0.26.x`, Maintenance `0.25.x`,
  End of life `≤ 0.24.x`, and no longer names `release/X.Y.x` branches that were never cut.
  `release-prepare` stamps the table from the minor on every release, and `verifyStamp` refuses a
  tag whose `SUPPORT.md` names the wrong Current line.

# Reclaim: GrowATL 2026 demo video script

Voice only, no face. A screen recording of the website and the app.
Target length: 2:00 (about 290 spoken words at a calm pace).
The application takes an MP4 or MOV of **10 MB at most**, so compress the export (see the end).

Demo file: `pitch/demo-files/reclaim-demo-payments.csv` is the sample ledger with export-style headings
(Contact, Date, Paid, Reference), so the column-matching step appears. Tested 2026-11-25: 80 payments, 12 vendors.

---

## 1. Hook (0:00–0:10)

**Screen:** Home page hero, "Find money your business should still have." Let the paper-stack animation play.

**Voice:**
> If your business pays four thousand bills a year, about sixty of them go out wrong.
> Paid twice. Paid too much. And almost nobody goes back to check.

(Source: APQC's median of 1.5% of disbursements going out duplicate or erroneous; the 4,000 → 60 arithmetic is on our research page.)

## 2. Problem (0:10–0:20)

**Screen:** Scroll slowly to "Most tools stop here. Reclaim keeps going."

**Voice:**
> Most software helps you pay your bills. Nothing goes back through them to find the mistakes,
> and get that money returned. That's what Reclaim does.

## 3. The idea in five steps (0:20–0:38)

**Screen:** Scroll into the laptop section. Let it zoom through Flagged, Proven, Approved, Requested, Settled.
Scroll steadily; don't flick.

**Voice:**
> It works in five steps. Reclaim flags the mistake. It shows you the proof.
> You approve the request. It tracks the reply.
> And it only counts money that actually comes back.

## 4. Upload (0:38–0:55)

**Screen:** Log in → **Upload a ledger** → drop `reclaim-demo-payments.csv` → the **Match the columns** screen
(hover over the suggested matches) → **Continue** → the confirm screen showing 80 payments and 12 vendors → run the audit.

**Voice:**
> Let's try it. You upload your payments, exported straight from QuickBooks, Xero, NetSuite or BILL,
> as a CSV or Excel file. If Reclaim doesn't recognize a column, it asks you.
> Nothing connects to your books, and nothing in them changes.

## 5. Overview (0:55–1:05)

**Screen:** The Overview. Pause on the totals, then on "By finding type."

**Voice:**
> Eight checks run in seconds, right in your browser. In these eighty payments,
> Reclaim found sixteen things worth a look: duplicate payments, overpayments,
> even a vendor whose bank account suddenly changed.

## 6. One finding, up close (1:05–1:25)

**Screen:** Findings → open **Exact duplicate payment, Sierra Coffee Supply, INV-3305**.
Show the two payments side by side, then the evidence questions.

**Voice:**
> Open one. Sierra Coffee was paid sixty-eight hundred dollars for the same invoice, twice, two weeks apart.
> Every finding shows the exact rows behind it, so you can check it yourself.
> Then a few plain questions: did both payments clear? Was it already refunded?
> Only then does it become a claim.

## 7. Getting the money back (1:25–1:42)

**Screen:** Confirm the evidence → the drafted request → **Approve**. Stop before anything is sent.
Then open **Recoveries**.

**Voice:**
> Reclaim writes the request from the records. Nothing reaches a vendor until you approve it,
> and it goes out from your own email. Then Recoveries keeps every reply you log,
> tells you when to follow up, and only marks it recovered when the money lands.

## 8. Trust and price (1:42–1:52)

**Screen:** Security page, "What Reclaim never gets." Then the Pricing page.

**Voice:**
> Reclaim can't move money, it never writes to your books, and AI never decides what counts as a mistake.
> You can start free.

## 9. Ending (1:52–2:00)

**Screen:** The closing band, "Don't just find the money. Reclaim it." Hold for two seconds, fade out.

**Voice:**
> Every business already has the records. Reclaim reads them, finds what went wrong,
> and helps you get it back.
> Don't just find the money. Reclaim it.

---

## Recording notes

- **Record signed in on a paid test account.** On the free plan, 13 of the 16 sample findings are hidden
  ("Vendor hidden", "$•,•••.••"), including Sierra Coffee. Don't sign up through /signup locally: it sends real email.
- **Don't press Send.** Gmail sending would email a real address. Approving is enough for the video.
- **"Draft with AI" isn't set up locally,** so show the drafted request Reclaim writes from the records, not the AI button.
- **Skip the tour and setup screens** before you start recording.
- Use one browser window at 1440 × 900, with the bookmarks bar and other tabs hidden, and turn on Do Not Disturb.
- Record the voice separately (Voice Memos is fine) and lay it over the screen recording, so you can retake lines.
- **Keep claims honest:** this is sample data, and there are no customers yet. Pricing is proposed.

## Fit it under 10 MB

For a 2:00 video, aim for about 560 kbps of video plus 64 kbps of audio:

```bash
ffmpeg -i demo.mov -vf "scale=1280:-2,fps=30" -c:v libx264 -preset slow -b:v 560k -pass 1 -an -f mp4 /dev/null && ffmpeg -i demo.mov -vf "scale=1280:-2,fps=30" -c:v libx264 -preset slow -b:v 560k -pass 2 -c:a aac -b:a 64k -movflags +faststart Reclaim_GrowATL_demo.mp4
```

Check the size with `ls -lh Reclaim_GrowATL_demo.mp4`. If it's over 10 MB, lower `560k`.

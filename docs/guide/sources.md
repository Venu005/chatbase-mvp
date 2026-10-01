# Knowledge sources

**Where:** Agent → **Sources**

The assistant answers only from what you give it. Each source is read, split into passages and indexed, so the right
passages are found for each question. Answers cite where they came from, like `[1]`, with a link to the page.

## Add a source

1. Choose **Website**, **File** or **Text / FAQ**.
2. **Website**: paste a URL and choose how many pages to read (this page, or up to 5, 10 or 20 pages on the same site).
3. **File**: upload a PDF, TXT, MD or CSV file up to 10 MB. With OCR set up by the platform, you can also upload scanned
   PDFs and photos (JPG, PNG, WebP) of price lists and menus.
4. **Text**: give it a title (for example "Refund policy") and paste the content.
5. Wait for the status to change from *processing* to *ready*. The number of passages shows how much was read.

## How your documents are read

- **By their structure.** Each passage stays inside one section and knows its heading, so the assistant can tell the
  electronics return policy from the clothing one. Citations name the section, for example
  "Store policies › Returns › Electronics".
- **Tables and spreadsheets keep their column names.** A row of your price list is stored as
  "Product: Atta 10kg · Code: AT-10 · MRP: 520 · Our price: 480", so "what's your price for AT-10?" finds the right
  number, not the MRP next to it.
- **PDFs keep their page numbers**, and repeated page headers and footers ("Page 3 of 12") are removed. Answers can
  cite "page 4".
- Menus, footers and scripts are stripped from web pages. Hindi text is split at the danda (।), so sentences stay whole.

## Keeping sources up to date

- **Websites are read again every week**, so answers follow your price changes. The Sources tab shows when a website was
  last read. Press **Refresh now** to read it again at once, for example right after you change a price.
- Only the parts that changed are processed again, so refreshing costs almost nothing when little has changed.
- If a refresh fails (your site is down, for example), the last good copy stays in use and the source says when the
  refresh failed.
- **Removing** a source makes the assistant forget it at once.

## When something goes wrong

- Temporary errors (rate limits, timeouts) are retried automatically. A server restart never loses work.
- A source that failed has a **Retry** button. Websites are read again; files and pasted text are processed again from
  the content kept when they were added.
- Websites built entirely with JavaScript can only be read if the platform has a page-rendering service; otherwise you
  get a message suggesting a PDF or pasted text instead.
- Private or internal addresses (for example `localhost`) are refused.

Up to 50 sources per agent.

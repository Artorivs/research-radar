# Read existing Sources only; no open-web crawling

The radar only reads Sources that already publish structured or semi-structured
material (APIs such as OpenAlex and J-STAGE, RSS feeds, society pages, job
boards, and mailing-list mail in a Gmail label). It never crawls the open web.
Crawling is fragile and costly to maintain, and for a single researcher with
near-zero upkeep the existing aggregators already capture most conferences and
papers. CNKI and Airiti are excluded for now because they offer no usable API
and scraping them breaks often; Chinese coverage comes from OpenAlex plus
named journal and society sites.

# Files the server reads

`danbooru.csv.gz`: danbooru's tags with how often each is used and its other names. It comes from
[DominikDoom/a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete)
(`tags/danbooru.csv`, MIT licence, as updated on 2025-01-03); its licence text is in
`LICENSE-danbooru-tags` beside it. Columns: tag, category (0 general,
1 artist, 3 copyright, 4 character, 5 meta), post count, other names.

It is what the tag check under an SDXL prompt compares your tags with. Nothing is sent anywhere.

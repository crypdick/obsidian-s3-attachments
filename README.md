# S3 attachments storage

![GitHub](https://img.shields.io/github/license/TechTheAwesome/obsidian-s3?style=for-the-badge)
![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/TechTheAwesome/obsidian-s3/ci.yml?style=for-the-badge)
[![wakatime](https://wakatime.com/badge/user/4312729e-bc28-4bc0-9074-161a64a7ad20/project/83a03e69-c8e0-49a9-ac01-a80c5ef7c96f.svg?style=for-the-badge)](https://wakatime.com/badge/user/4312729e-bc28-4bc0-9074-161a64a7ad20/project/83a03e69-c8e0-49a9-ac01-a80c5ef7c96f)

An [Obsidian](https://obsidian.md/) plugin for storage and retrieval of media attachments on S3 compatible services. 

![](assets/welcome.gif)
## Getting started
- Clone this repo.
- `npm i` to install dependencies
- `npm run build` to compile to `main.js`
## Manually installing the plugin
- Copy over `main.js`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/your-plugin-id/`.

## Settings (AWS example)

- **Endpoint**: For AWS S3 you can use `https://s3.<your-region>.amazonaws.com` (replace `<your-region>`, e.g. `us-east-1`). The plugin extracts the hostname. Other S3-compatible providers will have their own endpoint.
- **Folder Name**: Prefix inside the bucket (e.g. `files`).
- **Link mode**:
  - **Local proxy**: writes `http://localhost:4998/<folder>/<file>?client=...&bucket=...` (works with private buckets). **These links will break unless the plugin's local proxy server is enabled and running.**
  - **Public URL**: links will point to the public S3 URL instead of the localhost URL: `https://<public-base>/<folder>/<file>` (requires your bucket/objects to be publicly readable).
- **Public Base URL** (when Link mode = Public): for AWS, typically `https://<bucket>.s3.<region>.amazonaws.com`.

## IAM permissions

This plugin needs both bucket-level and object-level permissions. The following policy grants both:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BucketLevel",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::your-bucket-name"
    },
    {
      "Sid": "ObjectLevel",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    }
  ]
}
```

### Optional: make uploaded objects publicly readable

If you want attachments to be directly accessible via `https://<bucket>.s3.<region>.amazonaws.com/<prefix>/<key>`, you must also configure **bucket policy / Block Public Access** accordingly.

Example bucket policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadPrefix",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::your-bucket-name/your-prefix/*"
    }
  ]
}
```

Notes:
- Keep **Block Public Access** enabled unless you explicitly want public objects.
- If you keep the bucket private, the plugin can still fetch objects using credentials via its local proxy URLs (e.g. `http://localhost:4998/...`).

## Feature list
Supported files (limited by files allowed to be linked by Obsidian). By default, this plugin supports:

- Images: `.ico`, `.png`, `.jpg`/`.jpeg`, `.gif`, `.svg`
- Audio: `.mp3`, `.wav`
- Video: `.mp4`, `.webm`
- Documents/archives (as links): `.pdf`, `.zip`, `.doc`

You can customize this list in the plugin settings under **Allowed MIME Types**.
### Upload
- [x] Upload on paste.
- [x] Upload on drag-n-drop.
- [ ] Upload on adding attachments.

### Retrieval
- [x] Generate links for images.
- [x] Generate links for videos.
- [x] Generate links for audio.
- [x] Returning download links for un-supported resource? (pdf, txt, ...).
### Helpers/Misc
- [x] Command: delete un-used resources.
- [x] Command: Show bucket size
- [ ] Rename links on port/foldername changes.

### Unplanned
- [ ] Command: upload existing compatible attachments.
- [ ] Parallel uploads. 
- [ ] Retry counts and delays.
- [ ] Upload static html sites.
- [ ] Generate links for static html.
- [ ] Resource local caching (may increase incompatibility with mobile).

## Many thanks
Inspiration taken from:
- [obsidian-paste-png-to-jpeg](https://github.com/musug/obsidian-paste-png-to-jpeg)
- [Obsidian Imgur Plugin](https://github.com/gavvvr/obsidian-imgur-plugin)
- [Obsidian Static File Server](https://github.com/elias-sundqvist/obsidian-static-file-server)


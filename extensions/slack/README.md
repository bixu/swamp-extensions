# @bixu/slack

A [swamp](https://github.com/systeminit/swamp) extension model for sending
Markdown-formatted messages to Slack channels via the Slack Web API. Standard
Markdown (headings, bold, links, tables, fenced code blocks) is automatically
converted into Slack's native mrkdwn format, and long messages are split into
multiple Block Kit sections so they stay within API limits.

## Installation

```bash
swamp extension pull @bixu/slack
```

## Prerequisites

Create a Slack Bot with the **chat:write** OAuth scope and install it to your
workspace. Store the bot token (`xoxb-...`) in a swamp vault:

```bash
swamp vault set slack slackOauthToken "xoxb-your-token-here"
```

## Usage

Create a model definition that references the extension type:

```yaml
type: "@bixu/slack"
name: slack
globalArguments:
  slackOauthToken: ${{ vault.get('slack', 'slackOauthToken') }}
```

Then send messages with the `send` method:

```bash
# Send a simple message
swamp model method run slack send \
  --input channel="#general" \
  --input text="Hello from swamp!" --json

# Send a message with a title
swamp model method run slack send \
  --input channel="#ops" \
  --input title="Deploy Report" \
  --input text="All services healthy. No rollback needed." --json
```

### Markdown conversion

The extension converts standard Markdown into Slack mrkdwn automatically:

| Markdown           | Slack mrkdwn  |
| ------------------ | ------------- |
| `## Heading`       | `*Heading*`   |
| `**bold**`         | `*bold*`      |
| `[text](url)`      | `<url\|text>` |
| Fenced code blocks | Preserved     |
| Tables             | Aligned text  |

## Methods

### send

Send a Markdown message to a Slack channel.

**Arguments:**

- `channel` (string, required) — Channel name (with or without `#`) or channel
  ID.
- `text` (string, required) — Message content in standard Markdown.
- `title` (string, optional) — Title prepended as a bold header.

**Output resource:** `result` — contains `ok`, `channel`, `ts`, and
`permalink`.

## License

MIT — see [LICENSE.txt](LICENSE.txt).

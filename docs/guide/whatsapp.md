# WhatsApp

**Where:** Agent → **WhatsApp**

## Connect your number

- **Connect with Facebook** (when the platform has it set up): log in, pick or create a WhatsApp Business account and
  number, and you're done.
- **Or connect manually**: paste the Phone number ID, access token and app secret from Meta's developer console, then
  copy the webhook URL and verify token shown in the tab into Meta's WhatsApp configuration. Step by step:
  [WhatsApp: manual connection](../whatsapp.md).

Send a message to the number to test it.

## Good to know

- Answers are formatted for WhatsApp: `*bold*`, no citation markers, and up to two source links.
- Customers can type `human`, `agent` or "insaan se baat karni hai" to reach a person.
- Your replies from the inbox go to the customer's WhatsApp, within WhatsApp's 24-hour reply window.
- Every WhatsApp customer is added to [Leads](leads.md) with their number and WhatsApp profile name.
- Access tokens are stored encrypted. Each sender can send up to 10 messages a minute.

## Voice notes

Many customers send voice notes instead of typing. When the platform has a Sarvam key, voice notes are transcribed (Hindi,
English and other Indian languages are detected automatically) and answered as if the customer had typed them.

- In the inbox, the customer's message shows the transcript marked 🎤.
- If a person is handling the chat, the transcript goes to them and the assistant stays quiet.
- Voice notes longer than about 30 seconds, or ones that can't be understood, get a polite "please type your question".

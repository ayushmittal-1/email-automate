# Email Automation Tool

Send personalized AI-generated emails from a CSV file — no coding required.

---

## First-Time Setup (one time only)

1. **Install Node.js**
   - Go to https://nodejs.org
   - Click the big green **LTS** button
   - Open the downloaded file and follow the installer

2. That's it!

---

## How to Use

1. **Double-click `start.command`** — your browser will open automatically

2. **Fill in Settings** (click "Settings" to expand):
   - **OpenAI API Key** — get one at https://platform.openai.com/api-keys
   - **SMTP details** — your email provider's settings (host, port, username, password)
   - **Sender Name & Email** — how recipients will see you
   - **Email Prompt** — the instructions for AI to write emails
     Use `{Column Name}` to insert values from your CSV (e.g., `{Contact Person}`, `{Film Title}`)

3. **Upload your CSV file** — drag & drop or click to browse
   - Must have columns: `Email`, `Contact Person`, `Film Title`

4. **Click "Generate Previews"** — the AI writes an email for each row

5. **Review the emails** — remove any you don't want to send

6. **Click "Send All"** — emails are sent, and you'll see the status for each one

---

## CSV Format

Your CSV file should look like this:

```
Contact Person,Email,Film Title,Company
Alice Johnson,alice@example.com,The Last Horizon,Starlight Films
Bob Smith,bob@example.com,Midnight Echo,Crescent Studios
```

---

## Closing the App

Close the terminal window that opened when you double-clicked `start.command`.

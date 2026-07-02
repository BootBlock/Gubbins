# **🎙️ Home Assistant & Gubbins Voice Inventory Setup Guide**

This guide details the complete process of linking a local **Gubbins** inventory server to Home Assistant's conversation engine. By following these steps, you will build a robust, grammatically aware voice bridge that allows you to ask Google Home where an item is located, bypassing several known Home Assistant core bugs (such as IP string truncation and synchronous template crashes).

## **📑 Table of Contents**

* [Prerequisites](#bookmark=id.e6dgsf5lv5m1)  
* [Step 1: Configure the Shell Command](#bookmark=id.i98adbcvq4jm)  
* [Step 2: Create the Hardened Search Script](#bookmark=id.d0shlc4rajj9)  
  * [▶ Method A: Via the Home Assistant UI (Recommended)](#bookmark=id.a2uqrzvkghg)  
  * [▶ Method B: Via scripts.yaml (Advanced)](#bookmark=id.ze23gjr83gzy)  
* [Step 3: Build the Voice Automation](#bookmark=id.ny936w16qqo8)  
  * [▶ Method A: Via the Home Assistant UI (Recommended)](#bookmark=id.e1d2aibmp3yu)  
  * [▶ Method B: Via automations.yaml (Advanced)](#bookmark=id.llewizu82i05)  
* [Step 4: Patching Legacy Custom Components](#bookmark=id.55zvz7mhrcdt)  
* [Step 5: Finalisation & Google Home Setup](#bookmark=id.tefrm2laisx)  
* [Troubleshooting](#bookmark=id.otvezmavt156)

## **📋 Prerequisites**

Before you begin, ensure you have the following ready:

* **Home Assistant:** Running via Home Assistant OS or Core.  
* **Gubbins Server:** Running locally or on the same network subnet.  
* **API Bearer Token:** A static Authorisation token generated from your Gubbins instance.  
* **Google Home Routine:** The Google Home app installed on your smartphone to create the voice bridge.

💡 **A Note on Editing Files in Home Assistant**  
Throughout this guide, you will be asked to edit configuration files. You can do this in two ways:

1. **The UI Method (Recommended for Beginners):** Install the **File editor** or **Studio Code Server** from the Home Assistant Add-on store. This lets you edit files directly from your browser.  
2. **The SSH Method (Advanced):** If you are running Home Assistant Core on a custom OS, you can connect via SSH and use a terminal text editor like nano (e.g., nano /home/homeassistant/.homeassistant/configuration.yaml).

## **Step 1: Configure the Shell Command**

Home Assistant's native rest\_command integration can sometimes suffer from string truncation bugs when handling custom port numbers alongside dynamic variables. To guarantee reliable behaviour, we will use a native Linux curl shell command hitting the modern Gubbins v1 API.

1. Open your configuration.yaml file using your preferred editor.  
2. Paste the following block at the bottom of the file.

⚠️ **Important:** Replace the YOUR\_TOKEN\_HERE string with your actual Gubbins authorisation token. If your Gubbins server is *not* running on the exact same machine as Home Assistant, change 127.0.0.1 to the server's correct IP address.  
shell\_command:  
  query\_gubbins\_local: \>  
    curl \-s \-X GET "http://127.0.0.1:8787/api/v1/search?q={{ query | urlencode }}" \-H "Authorization: Bearer YOUR\_TOKEN\_HERE"

3. **Save the file.**

## **Step 2: Create the Hardened Search Script**

We must isolate the JSON parsing within a dedicated Home Assistant script. This script safely defaults to an empty dictionary {} if the search fails, preventing the automation pipeline from crashing. It also features a bespoke linguistic engine that tokenises workshop names, ensuring grammatically correct pronouns and handling virtual locations like "In Transit".  
*Choose your preferred method below:*

### **Method A: Via the Home Assistant UI (Script)**

*Recommended for most users.*

1. Navigate to **Settings** \> **Automations & Scenes** \> **Scripts**.  
2. Click **\+ Add Script** \> **Create new script**.  
3. In the top right corner, click the three dots (⋮) and select **Edit in YAML**.  
4. Delete any existing text and paste the code block below.  
5. Click **Save**.

### **Method B: Via scripts.yaml**

*For advanced users managing their configuration directly.*

1. Open your scripts.yaml file and paste the following definition at the bottom:

query\_gubbins\_inventory:  
  alias: "Query Gubbins Inventory"  
  mode: single  
  fields:  
    item\_to\_find:  
      description: "The dynamic entity the user is searching for"  
      example: "nailer"  
  sequence:  
    \- service: shell\_command.query\_gubbins\_local  
      data:  
        query: "{{ item\_to\_find }}"  
      response\_variable: cmd\_output  
    \- variables:  
        \# Safely parse the JSON payload  
        data: "{{ cmd\_output.stdout | default('{}', true) | from\_json }}"  
        script\_output:  
          speech: \>  
            {% if data.matches is defined and data.matches | length \> 0 %}  
              {% set item\_name \= data.matches\[0\].name %}  
              {% set item\_quantity \= data.matches\[0\].quantity | default(1, true) | int %}  
              {% set location \= data.matches\[0\].locationName %}  
                
              {\# Tokenise and extract the final word of the item name \#}  
              {% set name\_lower \= item\_name | lower | trim %}  
              {% set last\_word \= name\_lower.split(' ') | last %}  
                
              {\# Define linguistic exception maps for workshop environments \#}  
              {\# Feel free to add your own tool naming quirks to these arrays\! \#}  
              {% set mass\_nouns \= \['glue', 'tape', 'solder', 'paint', 'timber', 'wood', 'wire', 'grease', 'flux', 'sandpaper', 'oil', 'solvent', 'brass', 'glass', 'canvas', 'steel', 'iron', 'resin', 'wd-40', 'wd40'\] %}  
              {% set singular\_s \= \['compass', 'chassis', 'harness', 'press'\] %}  
              {% set always\_plural \= \['pliers', 'scissors', 'tweezers', 'shears', 'calipers', 'goggles', 'clippers', 'snips', 'dividers', 'strippers', 'scales'\] %}  
                
              {\# Execute the grammatical triage \#}  
              {% if last\_word in always\_plural %}  
                {% set pronoun \= 'them' %}  
              {% elif last\_word in mass\_nouns or last\_word in singular\_s %}  
                {% set pronoun \= 'it' %}  
              {% else %}  
                {\# Fallback to standard count and trailing-s rules (catches screws, nails, etc.) \#}  
                {% set ends\_in\_s \= last\_word\[-1:\] \== 's' %}  
                {% set pronoun \= 'them' if (item\_quantity \> 1 or ends\_in\_s) else 'it' %}  
              {% endif %}

              {\# Determine grammatical verb and check for virtual system states \#}  
              {% set verb \= 'are' if pronoun \== 'them' else 'is' %}  
              {% set loc\_lower \= location | lower | trim %}  
                
              {% if loc\_lower \== 'unassigned' %}  
                I found the {{ item\_name }} in the system, but {{ pronoun }} {{ verb }} currently unassigned to a physical location.  
              {% elif loc\_lower \== 'in transit' %}  
                The {{ item\_name }} {{ verb }} currently in transit.  
              {% else %}  
                I've located the {{ item\_name }}. You'll find {{ pronoun }} listed under: {{ location }}.  
              {% endif %}  
            {% else %}  
              I could not find "{{ item\_to\_find }}" in the inventory system.  
            {% endif %}  
    \- stop: "Yielding control back to the automation framework"  
      response\_variable: script\_output

## **Step 3: Build the Voice Automation**

Next, we need to instruct Home Assistant's Conversation engine to listen out for your specific search phrases. We do this by creating a voice-triggered automation that passes your spoken words to the script we just made.  
We have included a wide variety of natural trigger phrases. Words inside square brackets \[ \] are optional, allowing the engine to adapt beautifully to natural phrasing.  
*Choose your preferred method below:*

### **Method A: Via the Home Assistant UI (Automation)**

*Recommended for most users.*

1. Navigate to **Settings** \> **Automations & Scenes** \> **Automations**.  
2. Click **\+ Create Automation** \> **Create new automation**.  
3. In the top right corner, click the three dots (⋮) and select **Edit in YAML**.  
4. Delete any existing text and paste the code block below.  
5. Click **Save**.

### **Method B: Via automations.yaml**

*For advanced users managing their configuration directly.*

1. Open your automations.yaml file and paste this block at the bottom:

\- id: 'gubbins\_voice\_inventory\_search'  
  alias: "Gubbins Voice Inventory Search"  
  mode: single  
  trigger:  
    \- platform: conversation  
      command:  
        \- "locate \[the\] {item\_to\_find}"  
        \- "where is \[the\] {item\_to\_find}"  
        \- "where are \[the\] {item\_to\_find}"  
        \- "where is my {item\_to\_find}"  
        \- "where are my {item\_to\_find}"  
        \- "where's \[the\] {item\_to\_find}"  
        \- "where's my {item\_to\_find}"  
        \- "find \[the\] {item\_to\_find}"  
        \- "find my {item\_to\_find}"  
        \- "where did I put \[the\] {item\_to\_find}"  
        \- "where did I put my {item\_to\_find}"  
        \- "where did I leave \[the\] {item\_to\_find}"  
        \- "where did I leave my {item\_to\_find}"  
        \- "search for \[the\] {item\_to\_find}"  
        \- "look for \[the\] {item\_to\_find}"  
  action:  
    \- service: script.query\_gubbins\_inventory  
      data:  
        item\_to\_find: "{{ trigger.slots.item\_to\_find | trim }}"  
      response\_variable: script\_result  
    \- set\_conversation\_response: "{{ script\_result.speech }}"

## **Step 4: Patching Legacy Custom Components (SSH Required)**

🛑 **Note:** This step is only required if you previously installed an older version of the Gubbins integration into your custom\_components directory, and it is generating AttributeError or ImportError warnings in your system logs on startup.  
Older components use synchronous functions that crash the modern Home Assistant intent engine. You must use SSH to patch the Python files to modern asynchronous coroutines.

1. SSH into your Home Assistant host machine.  
2. Open the intent file: nano /path/to/homeassistant/custom\_components/gubbins/intent.py  
3. Change the function definition to include the async keyword and update the register call:  
   \# OLD:  
   \# def async\_register\_intent(hass):  
   \#     intent.async\_register\_intent(hass, GubbinsIntentHandler())

   \# NEW (Change to this):  
   async def async\_setup\_intents(hass):  
       \# ... keep the existing logic in the middle ...  
       intent.async\_register(hass, GubbinsIntentHandler())

4. Save and exit (Ctrl+O, Enter, Ctrl+X).  
5. Open the initialisation file: nano /path/to/homeassistant/custom\_components/gubbins/\_\_init\_\_.py  
6. Update the import statement and await the new function:  
   \# OLD:  
   \# from .intent import async\_register\_intent  
   \# async\_register\_intent(hass)

   \# NEW (Change to this):  
   from .intent import async\_setup\_intents  
   await async\_setup\_intents(hass)

7. Save and exit.

## **Step 5: Finalisation & Google Home Setup**

### **1\. Restart Home Assistant**

To apply all the YAML configurations and Python patches, Home Assistant must be fully restarted.

* **Via UI:** Go to **Developer Tools** \> **YAML** \> **Restart** (or manually click "Reload Automations" and "Reload Scripts").  
* **Via SSH:** Run sudo systemctl restart homeassistant (or home-assistant depending on your specific daemon configuration).

### **2\. Configure the Google Home Bridge**

Because Google Assistant does not natively pass dynamic wildcards (like *"nailer"*) cleanly to third-party APIs, we use a Google Home Routine to open a direct line to Home Assistant first.

1. Open the **Google Home App** on your smartphone.  
2. Navigate to **Automations** and tap the **\+** button to create a new Routine.  
3. **Add Starter:** Choose "When I say to Google Assistant" and type: Check location.  
4. **Add Action:** Choose "Communicate and announce", then "Make an announcement" (or use a custom command action). Set the text to: Talk to Home Assistant.  
5. Save the Routine.

### **🎯 How to Use It**

Walk up to your Google smart speaker and follow this flow:

1. **You:** *"Hey Google, check location."*  
2. **Google:** *(Opens the Home Assistant dialogue link and waits)*  
3. **You:** *"Where did I put the nails?"*  
4. **Home Assistant:** *"I've located the Box of 50mm Nails. You'll find them listed under: Workbench Drawer."*

## **🔧 Troubleshooting**

* **Always getting "I could not find..."?**  
  Run curl \-s \-X GET "http://127.0.0.1:8787/api/v1/search?q=test" \-H "Authorization: Bearer YOUR\_TOKEN" from your terminal. If it returns {"error": "Unauthorized"}, your Bearer token has likely expired or changed in the Gubbins web UI.  
* **Connection Refused / Hanging?**  
  Ensure your shell\_command IP address matches your setup. If Gubbins is running in a separate Docker container or on a different Raspberry Pi entirely, 127.0.0.1 will fail. Update it to the correct static IP (e.g., 192.168.0.5).
# MineScape Addons Launcher

MineScape Addons Launcher is an all-in-one launcher for playing MineScape with the recommended Addons setup.

The launcher signs in with your Minecraft account, prepares a local MineScape instance, downloads the required Minecraft/Fabric runtime files, syncs the required config data, and installs the managed Fabric mods from Modrinth. It also checks for launcher updates and config-data updates so you know when a new version is available or when Prepare Client needs to be run again.

## Requirements

- Windows
- Java installed and available through `JAVA_HOME` or `java` on `PATH`
- A Microsoft account that owns Minecraft: Java Edition
- Network access to Microsoft, Mojang, Fabric, Modrinth, GitHub, and MineScape

## Setup

1. Download the latest portable launcher `.exe` from the GitHub releases page.
2. Run the launcher.("Windows protected your PC" may pop-up as this isnt downloaded frequently. Click "More Info" then "Run Anyway")
3. Click **Sign in** and complete Microsoft/Minecraft authentication in your browser.
4. Click **Prepare Client**. The launcher will download Minecraft runtime files, Fabric files, MineScape config data(from https://github.com/MrZylr/MineScape-Addons-Resource-Pack), and the required mods.

   (This may take a while)
6. Click **Play** when the launcher says the client is ready.

Launcher data is stored in:

```text
%USERPROFILE%\.minescape_addons
```

Each signed-in account gets its own instance folder under:

```text
%USERPROFILE%\.minescape_addons\instances
```

## Updates

The launcher checks GitHub for a `launcher_version` file and compares it to the built-in launcher version. If they do not match, it shows an update notification with a link to the launcher page.

Config data has its own `version` file. If the local config data version does not match GitHub, the launcher disables Play and asks you to run **Prepare Client** so the latest files can be downloaded.

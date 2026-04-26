# MDBook

MDBook is a beautiful, offline-first Markdown note-taking and library application built with Electron.

## Features

- **Workspaces & Folders**: Organize your markdown files into separate workspaces (e.g., Programming, Personal, Languages).
- **Split-Pane Editor**: Write Markdown on the left and see a live-rendered HTML preview on the right.
- **Code Syntax Highlighting**: Fully integrated with `highlight.js` for gorgeous code snippets.
- **Integrated Terminal**: Includes a powerful, resizable bottom-panel terminal that automatically tracks your current working directory. Use `Ctrl + \`` to toggle it!
- **Theme Engine**: Switch between built-in Dark, Light, and Reader themes, or inject your own custom CSS variables to create your perfect aesthetic.
- **Auto-Save**: Never lose your work with customizable background auto-saving.

## Usage

You can download the bundled executable, or run from source:

```bash
# Install dependencies
npm install

# Run the app
npm start
```

## Settings & Data

All your settings, themes, and library indexes are securely stored in your local `userData` folder. You can find this path at the bottom of the Settings menu (`Ctrl + ,`).

---
Built with HTML, CSS, JavaScript, and Electron.

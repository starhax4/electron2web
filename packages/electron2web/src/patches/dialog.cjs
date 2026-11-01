'use strict';

// The real windows stay hidden, and a dialog parented to a hidden window may never
// appear (Windows) or attach as an invisible sheet (macOS). Show dialogs unparented.
// (In-tab dialogs are on the roadmap; until then dialogs stay native.)
module.exports = {
  name: 'dialog',
  install({ dialog, BaseWindow }) {
    const methods = ['showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync', 'showMessageBox', 'showMessageBoxSync'];
    for (const name of methods) {
      const original = dialog[name];
      dialog[name] = (...args) => original.apply(dialog, args[0] instanceof BaseWindow ? args.slice(1) : args);
    }
  },
};

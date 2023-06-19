Template.custom_modal.onRendered(function () {
  this.keypress = (e) => {
    if (e.key === "Escape" && typeof this.data?.onClose === "function") {
      this.data.onClose();
    }
  };
  document.activeElement?.blur();
  document.body.classList.add("no-scroll");
  document.addEventListener("keyup", this.keypress);
});

Template.custom_modal.onDestroyed(function () {
  document.body.classList.remove("no-scroll");
  document.removeEventListener("keyup", this.keypress);
});

Template.custom_modal.events({
  "click .custom-modal": (e, t) => {
    const { onClose } = t.data;
    if (e.target?.type != "submit" && typeof onClose === "function") {
      onClose();
    }
  },

  "click .custom-modal-view": (e, t) => {
    if (e.target?.type != "submit") {
      e.stopPropagation();
      e.preventDefault();
    }
  },
});

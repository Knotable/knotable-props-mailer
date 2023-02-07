Template.custom_modal.onRendered(function () {
  this.keypress = (e) => {
    if (e.key === "Escape" && typeof this.data?.onClose === "function") {
      this.data.onClose();
    }
  };
  document.body.classList.add("no-scroll");

  document.addEventListener("keypress", this.keypress);
});

Template.custom_modal.onDestroyed(function () {
  document.body.classList.remove("no-scroll");
  document.removeEventListener("keypress", this.keypress);
});

Template.custom_modal.events({
  "click .custom-modal": (e, t) => {
    const { onClose } = t.data;
    if (typeof onClose === "function") {
      onClose();
    }
  },

  "click .custom-modal-view": (e, t) => {
    e.stopPropagation();
    e.preventDefault();
  },
});

Template.file_item.helpers({
  size() {
    return FileHelper.fileSize2Text(this.size);
  },
});

Template.file_item.events({
  "click .file-actions button.delete": (e, t) => {
    Meteor.call("files.delete", [t.data._id], (err, res) => {
      if (err) showBootstrapGrowl(err.reason ?? err.message);
    });
  },
});

Template.file_item_1.helpers({
  size() {
    return FileHelper.fileSize2Text(this.size);
  },
});

Template.file_item_1.events({
  "click .file-item": (e, t) => {
    e.stopPropagation();
    console.log(">>>>>>", t);
    const { onClick } = t.data;
    if (typeof onCLick === "function") {
      onClick(t.data);
    }
  },
});

import { ReactiveVar } from "meteor/reactive-var";

Template.files_list.onCreated(function () {
  this.isLoading = new ReactiveVar(false);
  this.files = new ReactiveVar([]);
});

Template.files_list.onRendered(function () {
  const limit = 60;
  let skip = 0;
  let isCanLoadMore = false;

  this.load = () => {
    const files = this.files.get();
    if (this.isLoading.get() || files.length < skip) return;
    this.isLoading.set(true);
    Meteor.call("files.get", { skip, limit }, (err, res) => {
      if (res) {
        const arr = files.concat(res);
        skip += limit;
        this.files.set(arr);
      }
      this.isLoading.set(false);
    });
  };

  const observer = new IntersectionObserver((entries) => {
    const entry = entries[0];
    isCanLoadMore = entry.isIntersecting;
    if (isCanLoadMore) this.load();
  }, {});

  observer.observe(this.firstNode.querySelector(".footer"));

  const observerResize = new MutationObserver(() => {
    setTimeout(() => {
      if (isCanLoadMore) this.load();
    }, 100);
  });

  observerResize.observe(this.firstNode.querySelector(".files-list-content"), {
    childList: true,
  });

  this.deleteFile = (fileId) => {
    Meteor.call("files.delete", [fileId], (err, res) => {
      if (err) {
        showBootstrapGrowl(err.reason ?? err.message);
      } else {
        const files = this.files.get();
        const index = files.findIndex((file) => file._id == fileId);
        if (index < 0) return;
        files.splice(index, 1);
        this.files.set(files);
        skip -= 1;
      }
    });
  };
});

Template.files_list.helpers({
  isLoading() {
    return Template.instance().isLoading.get();
  },

  template() {
    const { template } = Template.parentData() ?? {};
    return template ?? "file_item";
  },

  files() {
    return Template.instance().files.get();
  },
});

Template.files_list.events({
  "click .file-item_1[data-file-id]": (e, t) => {
    const fileId = e.currentTarget.dataset?.fileId;
    const file = t.files.get().find((file) => file._id == fileId);
    const { onClick } = t.data;
    if (file && typeof onClick === "function") {
      onClick(file);
    }
  },

  "click .file-item[data-file-id] .file-actions button.delete": (e, t) => {
    const el = e.target.closest(".file-item");
    const fileId = el.dataset?.fileId;
    t.deleteFile(fileId);
  },
});

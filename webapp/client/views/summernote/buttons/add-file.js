export default function AddFileButton(context) {
  const ui = $.summernote.ui;

  let view;
  const select = (file) => {
    const img = document.createElement("img");
    img.alt = img.title = file.name;
    img.style.display = "block";
    img.src = file.s3_url;
    img.style = "width: 100%";
    close();
    context.invoke("editor.restoreRange");
    context.invoke("editor.focus");
    context.invoke("insertNode", img);
  };

  const close = () => {
    if (view) Blaze.remove(view);
    view = undefined;
  };

  const button = ui.button({
    contents: '<i class="fa fa-paperclip"/> Add File',
    click: function () {
      context.invoke("editor.saveRange");
      view = Blaze.renderWithData(
        Template.custom_modal,
        {
          size: "md",
          title: "Select File",
          template: {
            template: "files_list",
            data: {
              template: "file_item_1",
              onClick: select,
            },
          },
          onClose: close,
        },
        document.body
      );
    },
  });
  return button.render();
}

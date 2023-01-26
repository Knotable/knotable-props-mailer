export default function AddFileButton(context) {
  const ui = $.summernote.ui;

  let view;
  const select = (file) => {
    const img = document.createElement("img");
    img.alt = img.title = file.name;
    img.style.display = "block";
    img.src = file.s3_url;
    context.invoke("insertNode", img);
    close();
  };

  const close = () => {
    if (view) Blaze.remove(view);
    view = undefined;
  };

  const button = ui.button({
    contents: '<i class="fa fa-paperclip"/> Add File',
    click: function () {
      view = Blaze.renderWithData(
        Template.custom_modal,
        {
          size: "sm",
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

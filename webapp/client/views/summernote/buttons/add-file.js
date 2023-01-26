export default function AddFileButton(context) {
  const ui = $.summernote.ui;

  const select = (file) => {
    const img = document.createElement("img");
    img.alt = img.title = file.name;
    img.style.display = "block";
    img.src = url;
    context.invoke("insertNode", img);
  };

  const button = ui.button({
    contents: '<i class="fa fa-paperclip"/> Add File',
    click: function () {
      const view = Blaze.renderWithData(
        Template.custom_modal,
        {
          size: "sm",
          title: "Select File",
          template: {
            template: "files_list",
            data: {
              template: "file_item_1",
              onClick: () => {},
            },
          },
          onClose: () => {
            Blaze.remove(view);
          },
        },
        document.body
      );
    },
  });
  return button.render();
}

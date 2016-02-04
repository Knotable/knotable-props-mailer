@UiHelper =
  showLoading: () ->
    $('.loading-circle').removeClass('hidden')

  hideLoading: () ->
    $('.loading-circle').addClass('hidden')
"=========================================
" Load external Vim plugins with vim-plug
"=========================================

call plug#begin('~/.vim/plugged')

  " File manager
  Plug 'preservim/nerdtree'

  " Tab completion
  Plug 'ervandew/supertab'

  " Dealing with LaTeX files
  Plug 'lervag/vimtex'

  " Setting up remote Vim
  Plug 'wannesm/rmvim.vim'

  " Code completion
  Plug 'neoclide/coc.nvim', {'branch': 'release'}

  " Git integration
  Plug 'tpope/vim-fugitive'

  " Julia syntax highlighting
  Plug 'JuliaEditorSupport/julia-vim'

  " Colour scheme
  Plug 'gruvbox-community/gruvbox'

call plug#end()


"================
" General set up
"================
"
" Set colour scheme
colorscheme gruvbox

" Set background scheme
set background=dark
set bg=dark

" Disable bell
set noerrorbells visualbell

" Set menu colour
highlight Pmenu guibg=Black

" Automatically change the current working directory to the present file
set autochdir

" Enable line numbering
set number

" Set font for gVim
set guifont=Monospace\ 10

" Set column width
set textwidth=79
set wrapmargin=10

" Colour column
set colorcolumn=80

" No menu bar
set guioptions-=m  

" No toolbar
set guioptions-=T  

" No scrollbar
set guioptions-=r  

" Tab size
set tabstop=2 

" Shift size using > and <
set shiftwidth=2 

" Convert tabs into spaces
set expandtab 

" Enable auto-indent
set ai

" Map ½ to $ to enable easier navigation
map ½ $
imap ½ $

" Set the standard editor to be gVim when using rmvim
let g:rmvim_cmd = 'gvim'

" Set tex to be latex
let g:tex_flavor = 'latex'


"==============================
" Deal with clipboard nonsense
"==============================

" Set the gvim clipboard to be the standard clipboard
set clipboard=unnamed 

" Disable automatic copying selected text
" Here guioptions handles the GUI case and clipboard the other
set guioptions-=a
set clipboard-=autoselect

" Always copy into the standard clipboard register
vnoremap y "+y

" Disable copying when deleting with 'd'
nnoremap d "_d
vnoremap d "_d

" Set 'p' to paste into selection without copying the previous content
vnoremap p "_dP


"===============
" Custom macros
"===============

function EnableTeXKeyBindings()
  " Enables key bindings which are nice for TeXing
  so ~/.texrc
  echo 'LaTeX key bindings set!'
endfunction

function MarkdownToPDF()
  " Compiles and saves a markdown file as pdf
  w
  !pandoc '%' -o '%:r.pdf'
endfunction

function SmallFont()
  set guifont=Monospace\ 8
  set lines=150
  echo 'Small font set!'
endfunction

function NormalFont()
  set guifont=Monospace\ 10
  set lines=100
  echo 'Small font set!'
endfunction

function Remote(fname)
  let g:path = matchstr(expand('<sfile>:p:h'), '\(gitsky/\)\@<=.*')
  exe "e scp://dansat@balthazar.erst.dk//home/dansat/" . g:path . "/" . a:fname
endfunction

command P call MarkdownToPDF()
command T call EnableTeXKeyBindings()
command SF call SmallFont()
command NF call NormalFont()

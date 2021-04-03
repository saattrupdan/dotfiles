"=========================================
" Load external Vim plugins with vim-plug
"=========================================

" Set up VimPlug if it is not already
if empty(glob('~/.vim/autoload/plug.vim'))
    silent !curl -fLo ~/.vim/autoload/plug.vim --create-dirs
        \ https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim
endif

" Install plugins
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

" Extra linting column
set signcolumn=yes

" Set font for gVim
set guifont=Monospace\ 10

" No menu bar
set guioptions-=m

" No toolbar
set guioptions-=T

" No scrollbar
set guioptions-=r

" Tab size
set tabstop=4

" Shift size using > and <
set shiftwidth=4

" Convert tabs into spaces
set expandtab

" Enable auto-indent
set ai

" Offset lines when scrolling
set scrolloff=8

" Faster update time, default is 4000 = 4s
set updatetime=50

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

function RemoveTrailingWhitespace()
    let currentline=line(".")
    %s/\s\+$//e
    if line(".") != currentline
        :execute "normal 1\<c-o>"
    endif
endfunction

command P call MarkdownToPDF()
command T call EnableTeXKeyBindings()
command SF call SmallFont()
command NF call NormalFont()


"=====================
" Automatic functions
"=====================

augroup SAATTRUPDAN

    " Remove previous autocommands
    autocmd!

    " Remove trailing whitespace everytime :w is called
    autocmd BufWritePre * :call RemoveTrailingWhitespace()

    " Settings for files (and not Athame shell)
    autocmd BufRead,BufNewFile * set textwidth=79
    autocmd BufRead,BufNewFile * set wrapmargin=79
    autocmd BufRead,BufNewFile * set colorcolumn=80

augroup END

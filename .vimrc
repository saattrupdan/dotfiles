"=========================================
" Load external Vim plugins with vim-plug
"=========================================

" Set up VimPlug if it is not already installed
let data_dir = has('nvim') ? stdpath('data') . '/site' : '~/.vim'
if empty(glob(data_dir . '/autoload/plug.vim'))
  silent execute '!curl -fLo '.data_dir.'/autoload/plug.vim --create-dirs  https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim'
  autocmd VimEnter * PlugInstall --sync | source $MYVIMRC
endif

" Install plugins
call plug#begin('~/.vim/plugged')
    " GitHub Copilot
    Plug 'github/copilot.vim'

    " File manager
    Plug 'preservim/nerdtree'

    " Dealing with LaTeX files
    Plug 'lervag/vimtex'

    " Code completion and Linting through 'CocInstall coc-pyright'
    Plug 'neoclide/coc.nvim', {'branch': 'release'}

    " Git integration
    Plug 'tpope/vim-fugitive'

    " Fugitive extension for branches
    Plug 'idanarye/vim-merginal'

    " Julia syntax highlighting
    Plug 'JuliaEditorSupport/julia-vim'

    " Cypher syntax highlighting
    Plug 'memgraph/cypher.vim'

    " Status bar, with current branch information
    Plug 'itchyny/lightline.vim'

    " Colour schemes
    Plug 'gruvbox-community/gruvbox'

    " Switch to absolute line numbers when relative numbers don't make sense
    Plug 'jeffkreeftmeijer/vim-numbertoggle'

    " R support
    Plug 'jalvesaq/Nvim-R'

    " Fuzzy finder
    Plug 'nvim-lua/plenary.nvim'
    Plug 'nvim-telescope/telescope.nvim', { 'tag': '0.1.0' }
    Plug 'nvim-telescope/telescope-fzf-native.nvim', { 'do': 'make' }
    Plug 'nvim-treesitter/nvim-treesitter', {'do': ':TSUpdate'}

    " Vim Be Good
    Plug 'ThePrimeagen/vim-be-good'

call plug#end()


"================
" General set up
"================

" Disable swap files
set noswapfile

" Enable lightline status bar when only one buffer is open
set laststatus=2

" Show current branch in lightline status bar
let g:lightline = {
  \ 'colorscheme': 'one',
  \ 'active': {
  \   'left': [ [ 'mode', 'paste' ],
  \             [ 'gitbranch', 'readonly', 'filename', 'modified' ] ]
  \ },
  \ 'component_function': {
  \   'gitbranch': 'FugitiveHead'
  \ },
  \ }

" Set colour scheme
colorscheme gruvbox

" Set background scheme
set background=dark
set bg=dark

" Disable bell
set noerrorbells visualbell

" Automatically change the current working directory to the present file
set autochdir

" Enable absolute line numbering
set number

" Enable relative line numbering
set relativenumber

" Extra linting column
set signcolumn=yes

" Convert tabs into spaces
set expandtab

" Set default number of tab spaces
set tabstop=4
set shiftwidth=4

" Enable auto-indent
set ai

" Offset lines when scrolling
set scrolloff=30

" Faster update time, default is 4000 = 4s
set updatetime=50

" Map ½ and § to $ to enable easier navigation
map ½ $
imap ½ $
map § $
imap § $

" Set tex to be latex
let g:tex_flavor = 'latex'

" NERDTree set up
let g:NERDTreeIgnore = ['^__pycache__$']


"==============================
" Deal with clipboard nonsense
"==============================

" Set the clipboard to be the standard clipboard
set clipboard=unnamed

" Disable automatic copying selected text
set clipboard-=autoselect

" Always copy into the standard clipboard register
vnoremap y "+y

" Disable copying when deleting with 'd'
nnoremap d "_d
vnoremap d "_d

" Set 'p' to paste into selection without copying the previous content
vnoremap p "_dP


"========
" Remaps
"========

" Set leader key
let mapleader = ' '

" Open terminal in vim
nnoremap <leader>t :bot vert term<CR>

" Reload all buffers
nnoremap <leader>e :bufdo e!<CR>

" Git status
nnoremap <leader>gs :Git<CR>

" Git diff handling
nnoremap <leader>gd :Gdiff<CR>
vnoremap <leader>dg :diffget<CR>
vnoremap <leader>dp :diffput<CR>

" Git branches with vim-merginal extension
nnoremap <leader>gb :Merginal<CR>

" Toggle NERD tree
nnoremap <C-n> :NERDTreeToggle<CR>

" Focus NERD tree
nnoremap <leader>n :NERDTreeFocus<CR>

" Wrap text
nnoremap <leader><CR> gwgw
vnoremap <leader><CR> gw<CR>

" Copilot completion
let g:copilot_no_tab_map = v:true
inoremap <silent><script><expr> $ copilot#Accept("$")

" Breakpoints in Python
nnoremap <leader><leader> obreakpoint()<esc>:w<CR>
inoremap <C-b> breakpoint()<esc>:w<CR>
vnoremap <leader><leader> :s/\n/<temp>/g<CR>:s/\( *\)\([^ ].*\)/\1try:\r\1\t\2\r\1except:\r\1\tbreakpoint()\r<CR><esc>:nohlsearch<CR>kkk:s/<temp>/\r\t/g<CR>ddjj:w<CR>

" Enable tab completion for Coc
inoremap <silent><expr> <tab> coc#pum#visible() ? coc#pum#confirm() : "\<tab>"
inoremap <silent><expr> <ESC> coc#pum#visible() ? coc#pum#cancel() : "\<ESC>"

" Coc autocompletion scrolling
inoremap <silent><expr> j coc#pum#visible() ? coc#pum#next(0) : "\j"
inoremap <silent><expr> k coc#pum#visible() ? coc#pum#prev(0) : "\k"

" Coc tooltip scrolling
inoremap <silent><nowait><expr> J coc#float#has_scroll() ? "\<c-r>=coc#float#scroll(1)\<cr>" : "\J"
inoremap <silent><nowait><expr> K coc#float#has_scroll() ? "\<c-r>=coc#float#scroll(0)\<cr>" : "\K"

" Switch from Terminal mode to Normal mode
tnoremap <leader>nn <C-\><C-n>

" Find files using Telescope command-line sugar
nnoremap <leader>ff <cmd>Telescope git_files<cr>
nnoremap <leader>fg <cmd>Telescope live_grep<cr>
nnoremap <leader>fb <cmd>Telescope buffers<cr>
nnoremap <leader>fh <cmd>Telescope help_tags<cr>



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

function RemoveTrailingWhitespace()
    let currentline=line(".")
    %s/\s\+$//e
    if line(".") != currentline
        :execute "normal 1\<c-o>"
    endif
endfunction

command P call MarkdownToPDF()
command T call EnableTeXKeyBindings()


"=====================
" Automatic functions
"=====================

augroup SAATTRUPDAN

    " Remove previous autocommands
    autocmd!

    " Remove trailing whitespace everytime :w is called
    autocmd BufWritePre * :call RemoveTrailingWhitespace()

    " Settings for files (and not Athame shell)
    autocmd BufRead,BufNewFile * set textwidth=87
    autocmd BufRead,BufNewFile * set wrapmargin=87
    autocmd BufRead,BufNewFile * set colorcolumn=88

    " Start NERDTree and put the cursor back in the other window.
    autocmd VimEnter * silent NERDTree | wincmd p

    " Exit Vim if NERDTree is the only window left.
    autocmd BufEnter * if tabpagenr('$') == 1 && winnr('$') == 1 && exists('b:NERDTree') && b:NERDTree.isTabTree() |
        \ quit | endif

    " Set tab size depending on filetype
    autocmd FileType python set tabstop=4
    autocmd FileType html set tabstop=2
    autocmd FileType css set tabstop=2
    autocmd FileType javascript set tabstop=2
    autocmd FileType vue set tabstop=2

    " Set shift size using > and < depending on filetype
    autocmd FileType python set shiftwidth=4
    autocmd FileType html set shiftwidth=2
    autocmd FileType css set shiftwidth=2
    autocmd FileType javascript set shiftwidth=2
    autocmd FileType vue set shiftwidth=2

augroup END

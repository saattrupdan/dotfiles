# Set prompt to show trailing component of current path
# The '%F{154}...%f' enables colour 154, known as GreenYellow
# See all the colours available here: https://jonasjacek.github.io/colors/
PROMPT='%F{154}%1d$ %f'

# Athame config
unset zle_bracketed_paste

# PDF creation using Pandoc
pdf(){
  pandoc $1 -o ${1:0:(-3)}.pdf;
  echo "Created ${1:0:(-3)}.pdf"
}

# Open files faster
o(){
  ls | grep $1 | xargs gvim
}

# ERST vim
evim(){
  eval "gvim scp://dansat@balthazar.erst.dk//home/dansat/${PWD#*gitsky/}/$1"
}


#====================
# ZSH Suffix aliases
#====================

# PDFs
alias -s pdf='xdg-open'

# Images
alias -s jpg='xdg-open'
alias -s jpeg='xdg-open'
alias -s png='xdg-open'
alias -s bmp='xdg-open'

# Text-based
alias -s md='xdg-open'
alias -s py='xdg-open'
alias -s pyx='xdg-open'
alias -s c='xdg-open'
alias -s txt='xdg-open'
alias -s css='xdg-open'
alias -s html='xdg-open'
alias -s js='xdg-open'
alias -s go='xdg-open'
alias -s R='xdg-open'
alias -s sql='xdg-open'

# URLs
alias -s com='xdg-open'
alias -s uk='xdg-open'
alias -s dk='xdg-open'
alias -s io='xdg-open'
alias -s net='xdg-open'
alias -s org='xdg-open'
alias -s ai='xdg-open'
alias -s edu='xdg-open'
alias -s gov='xdg-open'


#=========
# Aliases
#=========

alias python='python3.8'
alias ls='exa'
alias grep='ack'
alias gt='cd ~/gitsky'
alias pc='cd ~/pCloudDrive'
alias gs='cd ~/gitsky && /usr/src/git-summary/git-summary && cd -'
alias rc='cp ~/.*rc ~/gitsky/dotfiles; cd ~/gitsky/dotfiles; git add .; git commit -m "chore: Update dot files"; git pull; git push; echo "Dot files backed up!"'
alias bb='brave-browser'

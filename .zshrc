# A bunch of fancy ZSH code to enable git integration. Taken from
# https://scriptingosx.com/2019/07/moving-to-zsh-06-customizing-the-zsh-prompt/
autoload -Uz vcs_info
setopt prompt_subst
zstyle ':vcs_info:*' enable git
precmd_vcs_info() { vcs_info }
precmd_functions+=( precmd_vcs_info )

# Set prompt to be "[current_branch] [parent_path/current_path]$"
# Here %b is the current branch name, and %F{xxx} ... %f colours the text
# colour xxx, where 170 is the colour "orchid" and 154 the colour
# "GreenYellow". See all colours available here:
# https://jonasjacek.github.io/colors/
zstyle ':vcs_info:git:*' formats '%F{170}[%b]%f '
PROMPT=\$vcs_info_msg_0_
PROMPT+='%F{154}%2~$ %f'

# Enable vi mode
bindkey -v

# PDF creation using Pandoc
pdf(){
  pandoc $1 -o ${1:0:(-3)}.pdf;
  echo "Created ${1:0:(-3)}.pdf"
}

# Open files faster
o(){
  ls | grep -i $1 | sed 's/^\(.*\)$/"\1"/g' | xargs -n 1 xdg-open
}

# Backup dotfiles
rc(){
  touch ~/.profile
  touch ~/.gitconfig

  cp ~/.*rc ~/gitsky/dotfiles
  cp ~/.profile ~/gitsky/dotfiles
  cp ~/.gitconfig ~/gitsky/dotfiles

  cd ~/gitsky/dotfiles
  git add .
  git commit -m "chore: Update dot files"
  git pull
  git push

  cd -
  cp ~/gitsky/dotfiles/.*rc ~/
  cp ~/gitsky/dotfiles/.profile ~/
  cp ~/gitsky/dotfiles/.gitconfig ~/

  echo "Dot files synced up!"
}

# Jump into a virtual environment, or build it if it is not there
vv(){
    if [ ! -d '.venv' ]; then
        python3 -m venv .venv
        source .venv/bin/activate
        pip3 install --upgrade pip setuptools wheel jedi pylint \
                               pytest pytest-flake8
        if [ -f 'requirements.txt' ]; then
            pip3 install -r requirements.txt
        fi
    else
        source .venv/bin/activate
    fi
}


#=========
# Aliases
#=========

alias ls='exa'
alias grep='ack'
alias gt='cd ~/gitsky'
alias pc='cd ~/pCloud\ Drive'
alias gsum='cd ~/gitsky && /usr/src/git-summary/git-summary && cd -'
alias bb='brave-browser'
alias ll='ls -l'
alias la='ls -ah'
alias lla='ls -lah'
alias gs='git status --short'
alias ga='git add'
alias gd='git diff'
alias gb='git branches'
alias gc='git checkout'
alias gl='git log --graph --pretty=format:"%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset" --abbrev-commit --date=relative'
alias pf='pip freeze | sed "/pkg-resources/d" > requirements.txt'
